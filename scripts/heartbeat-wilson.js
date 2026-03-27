#!/usr/bin/env node

/**
 * Wilson 心跳脚本 - 每 3 分钟运行
 * 
 * 职责：
 * 1. 扫描 evolution/tasks/ 中 status=pending 的任务
 * 2. 选择优先级最高的一个
 * 3. spawn Sonnet 子 agent 进行审阅
 * 4. Sonnet 审阅后将 status 改为 reviewed，写入 next_instructions
 * 
 * 运行方式：通过 OpenClaw cron 每 3 分钟触发
 */

const fs = require('fs');
const path = require('path');

// Resolve workspace from env or default to ~/.openclaw/agents/main/workspace
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || process.env.WORKSPACE || path.join(require('os').homedir(), '.openclaw', 'agents', 'main', 'workspace');
const TASKS_DIR = process.env.EVOLUTION_TASKS_DIR || path.join(WORKSPACE, 'evolution', 'tasks');
const LOCK_FILE = path.join(TASKS_DIR, '.wilson-heartbeat.lock');
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟锁超时

// ==================== 锁管理 ====================

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const age = Date.now() - lockData.timestamp;
      if (age < LOCK_TIMEOUT_MS) {
        console.log(`⏳ Wilson 心跳锁定中（${Math.round(age / 1000)}s ago），跳过`);
        return false;
      }
      console.log(`⚠️ 锁已过期（${Math.round(age / 1000)}s），强制获取`);
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ timestamp: Date.now(), pid: process.pid }));
    return true;
  } catch (err) {
    console.error('❌ 获取锁失败:', err.message);
    return false;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch (err) {
    console.error('⚠️ 释放锁失败:', err.message);
  }
}

// ==================== 任务扫描 ====================

function scanTasks() {
  const tasks = [];
  const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json') && f.startsWith('task-'));
  
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'));
      tasks.push({ file, ...data });
    } catch (err) {
      console.error(`⚠️ 读取 ${file} 失败:`, err.message);
    }
  }
  return tasks;
}

function findPendingTask(tasks) {
  const pending = tasks.filter(t => t.status === 'pending');
  if (pending.length === 0) return null;
  
  // 优先级排序：urgent > high > medium > low
  const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
  pending.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 99;
    const pb = priorityOrder[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    // 同优先级按 task_id 排序
    return a.task_id.localeCompare(b.task_id);
  });
  
  return pending[0];
}

// ==================== 审阅指令生成 ====================

function buildReviewPrompt(task) {
  const iteration = (task.current_iteration || 0) + 1;
  const subtasks = task.context?.subtasks || [];
  const lastResult = task.result || {};
  const completedStep = lastResult.subtask_completed || 0;
  const nextStep = completedStep + 1;
  
  let prompt = `你是 Sonnet 审计员，负责审阅 auto-evolution 任务。

## 任务信息
- **Task ID:** ${task.task_id}
- **目标:** ${task.goal}
- **当前迭代:** ${iteration} / ${task.max_iterations}
- **已完成 subtask:** ${completedStep} / ${subtasks.length}

## Subtasks 列表
${subtasks.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## 上一轮执行结果
${lastResult.output || lastResult.summary || '（首次审阅，无上轮结果）'}
`;

  if (completedStep >= subtasks.length) {
    prompt += `
## 所有 subtasks 已完成！
请将 verdict 设为 "complete"，并总结任务成果。
`;
  } else {
    prompt += `
## 你的任务
1. 审阅上一轮执行结果（如有）
2. 确认是否通过（approve/revise）
3. 为第 ${nextStep} 个 subtask 写出**具体执行指令**
4. 定义验收标准

## 输出格式（严格 JSON）
\`\`\`json
{
  "verdict": "approve",
  "feedback": "审阅意见...",
  "next_instructions": {
    "summary": "第 ${iteration} 轮迭代：完成 Step ${nextStep}",
    "current_step": ${nextStep},
    "total_steps": ${subtasks.length},
    "step": {
      "step": ${nextStep},
      "action": "${subtasks[nextStep - 1] || ''}",
      "detail": "具体实现细节..."
    },
    "acceptance_criteria": ["验收标准1", "验收标准2"]
  }
}
\`\`\`

只输出 JSON，不要其他内容。
`;
  }

  return prompt;
}

// ==================== 更新任务文件 ====================

function updateTaskAfterReview(task, reviewResult) {
  const filePath = path.join(TASKS_DIR, task.file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  
  const now = new Date().toISOString();
  
  // 解析审阅结果
  let review;
  try {
    // 尝试从 JSON 代码块中提取
    const jsonMatch = reviewResult.match(/```json\s*([\s\S]*?)\s*```/) || 
                      reviewResult.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : reviewResult;
    review = JSON.parse(jsonStr);
  } catch (err) {
    console.error('⚠️ 解析审阅结果失败，使用默认值:', err.message);
    review = {
      verdict: 'approve',
      feedback: reviewResult,
      next_instructions: null
    };
  }
  
  if (review.verdict === 'complete') {
    data.status = 'completed';
    data.review = {
      verdict: 'complete',
      reviewed_at: now,
      reviewed_by: 'WILSON',
      feedback: review.feedback || review
    };
  } else {
    data.status = 'reviewed';
    data.current_iteration = (data.current_iteration || 0) + 1;
    data.review = {
      verdict: review.verdict || 'approve',
      reviewed_at: now,
      reviewed_by: 'WILSON',
      feedback: review.feedback || '',
      next_instructions: review.next_instructions || null
    };
  }
  
  data.updated_at = now;
  
  // 追加历史记录
  if (!data.history) data.history = [];
  data.history.push({
    timestamp: now,
    action: `iteration_${data.current_iteration}_reviewed`,
    agent: 'WILSON',
    model: 'aiberm/claude-sonnet-4-6',
    verdict: review.verdict,
    notes: review.feedback || `审阅完成，verdict: ${review.verdict}`
  });
  
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`✅ 任务 ${task.task_id} 审阅完成: ${review.verdict}`);
  return review.verdict;
}

// ==================== 主流程 ====================

async function main() {
  console.log(`\n🧠 Wilson 心跳 @ ${new Date().toISOString()}`);
  
  if (!acquireLock()) return;
  
  try {
    const tasks = scanTasks();
    console.log(`📋 发现 ${tasks.length} 个任务`);
    
    // 统计
    const statusCounts = {};
    for (const t of tasks) {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    }
    console.log(`📊 状态分布:`, JSON.stringify(statusCounts));
    
    // 查找 pending 任务
    const pendingTask = findPendingTask(tasks);
    if (!pendingTask) {
      console.log('✅ 无 pending 任务，心跳结束');
      
      // 检查是否有 completed 任务需要打包
      const completed = tasks.filter(t => t.status === 'completed');
      if (completed.length > 0) {
        console.log(`📦 发现 ${completed.length} 个 completed 任务待打包`);
        // 打包逻辑由 pack-skill.js 处理
      }
      return;
    }
    
    console.log(`🎯 选中任务: ${pendingTask.task_id} - ${pendingTask.goal}`);
    
    // 生成审阅 prompt
    const reviewPrompt = buildReviewPrompt(pendingTask);
    
    // 输出 prompt 供 cron message 使用
    // 在 cron 模式下，这个脚本的输出会被 Wilson agent 读取
    // Wilson agent 再 spawn Sonnet 子 agent 执行审阅
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

// 如果直接运行（非 cron），也支持传入审阅结果
if (process.argv[2] === 'apply-review') {
  const taskFile = process.argv[3];
  const reviewFile = process.argv[4];
  
  if (!taskFile || !reviewFile) {
    console.error('用法: node heartbeat-wilson.js apply-review <task-file> <review-result-file>');
    process.exit(1);
  }
  
  const task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, taskFile), 'utf8'));
  task.file = taskFile;
  const reviewResult = fs.readFileSync(reviewFile, 'utf8');
  updateTaskAfterReview(task, reviewResult);
} else {
  main().catch(err => {
    console.error('❌ 心跳异常:', err);
    releaseLock();
  });
}

module.exports = { scanTasks, findPendingTask, buildReviewPrompt, updateTaskAfterReview };
