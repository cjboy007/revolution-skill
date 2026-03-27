#!/usr/bin/env node

/**
 * Iron 心跳脚本 - 每 5 分钟运行
 * 
 * 职责：
 * 1. 扫描 evolution/tasks/ 中 status=reviewed 的任务
 * 2. 读取 review.next_instructions
 * 3. 执行当前 subtask（开发模式：写代码 / 测试模式：跑测试+修 bug）
 * 4. 测试失败时：尝试调用 Sonnet 修复，修复后重测
 * 5. 完成后将 status 改为 pending（等待下轮审阅）
 * 
 * 运行方式：通过 OpenClaw cron 每 5 分钟触发（测试超时 15 分钟）
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Resolve workspace from env or default to ~/.openclaw/agents/main/workspace
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || process.env.WORKSPACE || path.join(require('os').homedir(), '.openclaw', 'agents', 'main', 'workspace');
const TASKS_DIR = process.env.EVOLUTION_TASKS_DIR || path.join(WORKSPACE, 'evolution', 'tasks');
const SKILLS_DIR = process.env.EVOLUTION_SKILLS_DIR || path.join(WORKSPACE, 'skills');
const LOCK_FILE = path.join(TASKS_DIR, '.iron-heartbeat.lock');
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

// ==================== 锁管理 ====================

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const age = Date.now() - lockData.timestamp;
      if (age < LOCK_TIMEOUT_MS) {
        console.log(`⏳ Iron 心跳锁定中（${Math.round(age / 1000)}s ago），跳过`);
        return false;
      }
      console.log(`⚠️ 锁已过期，强制获取`);
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
  } catch (err) {}
}

// ==================== 任务扫描 ====================

function findReviewedTask() {
  const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json') && f.startsWith('task-'));
  
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'));
      if (data.status === 'reviewed') {
        return { file, ...data };
      }
    } catch (err) {}
  }
  return null;
}

// ==================== 执行指令生成 ====================

function buildExecutionPrompt(task) {
  const instructions = task.review?.next_instructions;
  if (!instructions) {
    return `任务 ${task.task_id} 已审阅但缺少 next_instructions，请检查。`;
  }
  
  const step = instructions.step || {};
  const criteria = instructions.acceptance_criteria || [];
  
  return `你是 Iron 执行者。请执行以下测试 subtask。

## 任务信息
- **Task ID:** ${task.task_id}
- **目标:** ${task.goal}
- **当前步骤:** ${instructions.current_step} / ${instructions.total_steps}
- **Skill 目录:** ${SKILLS_DIR}

## 要执行的 Subtask
**${step.action || instructions.summary}**

${step.detail || ''}

## 验收标准
${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## 约束
- 所有脚本路径基于 ${SKILLS_DIR}
- 测试结果写入 ${path.join(WORKSPACE, 'evolution', 'test-results')}
- 失败时：分析错误原因，尝试修复代码/配置后重测
- 无法修复时：在 summary 中详细描述问题，设置 needs_manual: true

## 完成后
执行完毕后输出：
\`\`\`json
{
  "subtask_completed": ${instructions.current_step},
  "output_file": "测试结果文件路径",
  "summary": "测试摘要（pass/fail + 修复记录）",
  "acceptance_criteria_met": ["已满足的验收标准"],
  "needs_manual": false,
  "fixes_applied": ["修复内容（如有）"]
}
\`\`\`
`;
}

// ==================== 更新任务文件 ====================

function updateTaskAfterExecution(task, executionResult) {
  const filePath = path.join(TASKS_DIR, task.file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  
  const now = new Date().toISOString();
  
  // 解析执行结果
  let result;
  try {
    const jsonMatch = executionResult.match(/```json\s*([\s\S]*?)\s*```/) || 
                      executionResult.match(/\{[\s\S]*"subtask_completed"[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : executionResult;
    result = JSON.parse(jsonStr);
  } catch (err) {
    result = {
      subtask_completed: (data.review?.next_instructions?.current_step || 0),
      output_file: '',
      summary: executionResult
    };
  }
  
  // 检查是否所有 subtask 都完成了
  const totalSteps = data.context?.subtasks?.length || 6;
  const completedStep = result.subtask_completed || 0;
  
  data.status = 'pending'; // 回到 pending 等待下轮审阅
  data.updated_at = now;
  data.result = {
    iteration: data.current_iteration,
    completed_at: now,
    subtask_completed: completedStep,
    output_file: result.output_file || '',
    summary: result.summary || '',
    acceptance_criteria_met: result.acceptance_criteria_met || []
  };
  
  // 追加历史
  if (!data.history) data.history = [];
  data.history.push({
    timestamp: now,
    action: `iteration_${data.current_iteration}_executed`,
    agent: 'IRON',
    model: 'bailian/qwen3.5-plus',
    subtask: completedStep,
    result: 'success',
    output_file: result.output_file || '',
    notes: result.summary || `Step ${completedStep} 完成`
  });
  
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`✅ 任务 ${task.task_id} Step ${completedStep} 执行完成`);
}

// ==================== 主流程 ====================

async function main() {
  console.log(`\n⚙️ Iron 心跳 @ ${new Date().toISOString()}`);
  
  if (!acquireLock()) return;
  
  try {
    const task = findReviewedTask();
    
    if (!task) {
      console.log('✅ 无 reviewed 任务，心跳结束');
      return;
    }
    
    console.log(`🎯 执行任务: ${task.task_id} - ${task.goal}`);
    console.log(`📋 Step: ${task.review?.next_instructions?.current_step || '?'} / ${task.review?.next_instructions?.total_steps || '?'}`);
    
    // 生成执行 prompt
    const execPrompt = buildExecutionPrompt(task);
    
    // 输出 prompt 供 cron message 使用
    console.log('\n--- EXEC_PROMPT_START ---');
    console.log(JSON.stringify({
      task_id: task.task_id,
      task_file: task.file,
      prompt: execPrompt
    }));
    console.log('--- EXEC_PROMPT_END ---');
    
  } finally {
    releaseLock();
  }
}

if (process.argv[2] === 'apply-result') {
  const taskFile = process.argv[3];
  const resultFile = process.argv[4];
  
  if (!taskFile || !resultFile) {
    console.error('用法: node heartbeat-iron.js apply-result <task-file> <result-file>');
    process.exit(1);
  }
  
  const task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, taskFile), 'utf8'));
  task.file = taskFile;
  const resultText = fs.readFileSync(resultFile, 'utf8');
  updateTaskAfterExecution(task, resultText);
} else {
  main().catch(err => {
    console.error('❌ 心跳异常:', err);
    releaseLock();
  });
}

module.exports = { findReviewedTask, buildExecutionPrompt, updateTaskAfterExecution };
