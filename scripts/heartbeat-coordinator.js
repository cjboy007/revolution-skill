#!/usr/bin/env node

/**
 * Coordinator Heartbeat — the single entry point for the evolution loop.
 * 
 * Runs on a timer (heartbeat or cron). Each tick:
 * 1. Scans tasks/ for the highest-priority "pending" task
 * 2. Outputs a review prompt for the coordinator to spawn a Reviewer sub-agent
 * 3. After review, outputs an execution prompt to spawn an Executor sub-agent
 * 
 * The coordinator agent reads this script's output and drives the loop
 * by spawning sub-agents (sessions_spawn) for review and execution.
 * 
 * No agent names are hardcoded — roles are filled by whoever the
 * coordinator spawns. Models are configured at spawn time.
 * 
 * CLI usage:
 *   node heartbeat-coordinator.js                    # scan + output prompts
 *   node heartbeat-coordinator.js apply-review <task-file> <review-result-file>
 *   node heartbeat-coordinator.js apply-result <task-file> <exec-result-file>
 */

const fs = require('fs');
const path = require('path');

// Resolve workspace — env > cwd fallback
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || process.env.WORKSPACE || path.join(require('os').homedir(), '.openclaw', 'agents', 'main', 'workspace');
const TASKS_DIR = process.env.EVOLUTION_TASKS_DIR || path.join(WORKSPACE, 'evolution', 'tasks');
const SKILLS_DIR = process.env.EVOLUTION_SKILLS_DIR || path.join(WORKSPACE, 'skills');
const LOCK_FILE = path.join(TASKS_DIR, '.coordinator.lock');
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

// ==================== Lock Management ====================

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const age = Date.now() - lockData.timestamp;
      if (age < LOCK_TIMEOUT_MS) {
        console.log(`⏳ Coordinator locked (${Math.round(age / 1000)}s ago), skipping`);
        return false;
      }
      console.log(`⚠️ Lock expired (${Math.round(age / 1000)}s), force-acquiring`);
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ timestamp: Date.now(), pid: process.pid }));
    return true;
  } catch (err) {
    console.error('❌ Failed to acquire lock:', err.message);
    return false;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch (err) {
    console.error('⚠️ Failed to release lock:', err.message);
  }
}

// ==================== Task Scanning ====================

function scanTasks() {
  if (!fs.existsSync(TASKS_DIR)) {
    console.log(`📁 Tasks directory not found: ${TASKS_DIR}`);
    return [];
  }
  const tasks = [];
  const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json') && f.startsWith('task-'));
  
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'));
      tasks.push({ file, ...data });
    } catch (err) {
      console.error(`⚠️ Failed to read ${file}:`, err.message);
    }
  }
  return tasks;
}

function findPendingTask(tasks) {
  const pending = tasks.filter(t => t.status === 'pending');
  if (pending.length === 0) return null;
  
  const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
  pending.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 99;
    const pb = priorityOrder[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.task_id.localeCompare(b.task_id);
  });
  
  return pending[0];
}

// ==================== Review Prompt ====================

function buildReviewPrompt(task) {
  const iteration = (task.current_iteration || 0) + 1;
  const subtasks = task.context?.subtasks || [];
  const lastResult = task.result || {};
  const completedStep = lastResult.subtask_completed || 0;
  const nextStep = completedStep + 1;
  
  let prompt = `You are a Reviewer for the auto-evolution system.

## Task Info
- **Task ID:** ${task.task_id}
- **Goal:** ${task.goal}
- **Iteration:** ${iteration} / ${task.max_iterations}
- **Completed subtasks:** ${completedStep} / ${subtasks.length}

## Subtasks
${subtasks.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## Previous Result
${lastResult.output || lastResult.summary || '(First review, no previous result)'}
`;

  if (completedStep >= subtasks.length) {
    prompt += `
## All subtasks completed!
Set verdict to "complete" and summarize the task outcome.
`;
  } else {
    prompt += `
## Your Job
1. Review the previous execution result (if any)
2. Decide: approve / revise
3. Write specific execution instructions for subtask ${nextStep}
4. Define acceptance criteria

## Output Format (strict JSON)
\`\`\`json
{
  "verdict": "approve",
  "feedback": "Review comments...",
  "next_instructions": {
    "summary": "Iteration ${iteration}: Complete Step ${nextStep}",
    "current_step": ${nextStep},
    "total_steps": ${subtasks.length},
    "step": {
      "step": ${nextStep},
      "action": "${subtasks[nextStep - 1] || ''}",
      "detail": "Specific implementation details..."
    },
    "acceptance_criteria": ["Criterion 1", "Criterion 2"]
  }
}
\`\`\`

Output only JSON, nothing else.
`;
  }

  return prompt;
}

// ==================== Execution Prompt ====================

function buildExecutionPrompt(task) {
  const instructions = task.review?.next_instructions;
  if (!instructions) {
    return `Task ${task.task_id} is reviewed but missing next_instructions.`;
  }
  
  const step = instructions.step || {};
  const criteria = instructions.acceptance_criteria || [];
  
  return `You are an Executor for the auto-evolution system.

## Task Info
- **Task ID:** ${task.task_id}
- **Goal:** ${task.goal}
- **Current Step:** ${instructions.current_step} / ${instructions.total_steps}

## Subtask to Execute
**${step.action || instructions.summary}**

${step.detail || ''}

## Acceptance Criteria
${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Rules
- Run verification commands after each change
- If verification fails, attempt to fix (up to 3 tries)
- If unfixable, set needs_manual: true and describe the issue

## Output Format (strict JSON)
\`\`\`json
{
  "subtask_completed": ${instructions.current_step},
  "summary": "What was done",
  "acceptance_criteria_met": ["Criteria that passed"],
  "needs_manual": false,
  "fixes_applied": ["Fix descriptions (if any)"]
}
\`\`\`
`;
}

// ==================== Task Updates ====================

function updateTaskAfterReview(task, reviewResult) {
  const filePath = path.join(TASKS_DIR, task.file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const now = new Date().toISOString();
  
  let review;
  try {
    const jsonMatch = reviewResult.match(/```json\s*([\s\S]*?)\s*```/) || 
                      reviewResult.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : reviewResult;
    review = JSON.parse(jsonStr);
  } catch (err) {
    console.error('⚠️ Failed to parse review result:', err.message);
    review = { verdict: 'approve', feedback: reviewResult, next_instructions: null };
  }
  
  if (review.verdict === 'complete') {
    data.status = 'completed';
    data.review = { verdict: 'complete', reviewed_at: now, feedback: review.feedback || review };
  } else {
    data.status = 'reviewed';
    data.current_iteration = (data.current_iteration || 0) + 1;
    data.review = {
      verdict: review.verdict || 'approve',
      reviewed_at: now,
      feedback: review.feedback || '',
      next_instructions: review.next_instructions || null
    };
  }
  
  data.updated_at = now;
  if (!data.history) data.history = [];
  data.history.push({
    timestamp: now,
    action: `iteration_${data.current_iteration || 0}_reviewed`,
    role: 'reviewer',
    verdict: review.verdict,
    notes: review.feedback || `Review done: ${review.verdict}`
  });
  
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`✅ Task ${task.task_id} reviewed: ${review.verdict}`);
  return review.verdict;
}

function updateTaskAfterExecution(task, executionResult) {
  const filePath = path.join(TASKS_DIR, task.file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const now = new Date().toISOString();
  
  let result;
  try {
    const jsonMatch = executionResult.match(/```json\s*([\s\S]*?)\s*```/) || 
                      executionResult.match(/\{[\s\S]*"subtask_completed"[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : executionResult;
    result = JSON.parse(jsonStr);
  } catch (err) {
    result = {
      subtask_completed: (data.review?.next_instructions?.current_step || 0),
      summary: executionResult
    };
  }
  
  data.status = 'pending'; // Back to pending for next review cycle
  data.updated_at = now;
  data.result = {
    iteration: data.current_iteration,
    completed_at: now,
    subtask_completed: result.subtask_completed || 0,
    summary: result.summary || '',
    acceptance_criteria_met: result.acceptance_criteria_met || []
  };
  
  if (!data.history) data.history = [];
  data.history.push({
    timestamp: now,
    action: `iteration_${data.current_iteration}_executed`,
    role: 'executor',
    subtask: result.subtask_completed || 0,
    result: 'success',
    notes: result.summary || `Step ${result.subtask_completed} done`
  });
  
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`✅ Task ${task.task_id} step ${result.subtask_completed} executed`);
}

// ==================== Main ====================

async function main() {
  console.log(`\n🔄 Coordinator heartbeat @ ${new Date().toISOString()}`);
  
  if (!acquireLock()) return;
  
  try {
    const tasks = scanTasks();
    console.log(`📋 Found ${tasks.length} tasks`);
    
    const statusCounts = {};
    for (const t of tasks) {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    }
    console.log(`📊 Status:`, JSON.stringify(statusCounts));
    
    const pendingTask = findPendingTask(tasks);
    if (!pendingTask) {
      console.log('✅ No pending tasks');
      const completed = tasks.filter(t => t.status === 'completed');
      if (completed.length > 0) {
        console.log(`📦 ${completed.length} completed tasks ready for packaging`);
      }
      return;
    }
    
    console.log(`🎯 Selected: ${pendingTask.task_id} - ${pendingTask.goal}`);
    
    const reviewPrompt = buildReviewPrompt(pendingTask);
    
    console.log('\n--- REVIEW_PROMPT_START ---');
    console.log(JSON.stringify({
      task_id: pendingTask.task_id,
      task_file: pendingTask.file,
      prompt: reviewPrompt
    }));
    console.log('--- REVIEW_PROMPT_END ---');
    
  } finally {
    releaseLock();
  }
}

// CLI sub-commands
if (process.argv[2] === 'apply-review') {
  const taskFile = process.argv[3];
  const reviewFile = process.argv[4];
  if (!taskFile || !reviewFile) {
    console.error('Usage: node heartbeat-coordinator.js apply-review <task-file> <review-result-file>');
    process.exit(1);
  }
  const task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, taskFile), 'utf8'));
  task.file = taskFile;
  updateTaskAfterReview(task, fs.readFileSync(reviewFile, 'utf8'));

} else if (process.argv[2] === 'apply-result') {
  const taskFile = process.argv[3];
  const resultFile = process.argv[4];
  if (!taskFile || !resultFile) {
    console.error('Usage: node heartbeat-coordinator.js apply-result <task-file> <exec-result-file>');
    process.exit(1);
  }
  const task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, taskFile), 'utf8'));
  task.file = taskFile;
  updateTaskAfterExecution(task, fs.readFileSync(resultFile, 'utf8'));

} else {
  main().catch(err => {
    console.error('❌ Heartbeat error:', err);
    releaseLock();
  });
}

module.exports = { scanTasks, findPendingTask, buildReviewPrompt, buildExecutionPrompt, updateTaskAfterReview, updateTaskAfterExecution };
