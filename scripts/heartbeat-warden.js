#!/usr/bin/env node

/**
 * WARDEN 监督脚本 - 每 10 分钟运行
 * 
 * 职责：
 * 1. 检测卡在 reviewing/executing 超过 10 分钟的任务 → 自动重置
 * 2. 清理泄漏的 .lock 文件
 * 3. 检测连续失败 → 报告异常
 */

const fs = require('fs');
const path = require('path');

// Resolve workspace from env or default to ~/.openclaw/agents/main/workspace
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || process.env.WORKSPACE || path.join(require('os').homedir(), '.openclaw', 'agents', 'main', 'workspace');
const TASKS_DIR = process.env.EVOLUTION_TASKS_DIR || path.join(WORKSPACE, 'evolution', 'tasks');
const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 分钟

function main() {
  console.log(`\n🛡️ WARDEN 监督 @ ${new Date().toISOString()}`);
  
  let issues = [];
  
  // 1. 清理过期锁
  for (const lockName of ['.wilson-heartbeat.lock', '.iron-heartbeat.lock']) {
    const lockPath = path.join(TASKS_DIR, lockName);
    if (fs.existsSync(lockPath)) {
      try {
        const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const age = Date.now() - lockData.timestamp;
        if (age > STUCK_THRESHOLD_MS) {
          fs.unlinkSync(lockPath);
          issues.push(`🔓 清理过期锁: ${lockName}（${Math.round(age / 60000)}分钟）`);
        }
      } catch (err) {
        fs.unlinkSync(lockPath);
        issues.push(`🔓 清理损坏锁: ${lockName}`);
      }
    }
  }
  
  // 2. 检测卡住的任务
  const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json') && f.startsWith('task-'));
  
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'));
      
      if (['reviewing', 'executing'].includes(data.status)) {
        const updatedAt = new Date(data.updated_at).getTime();
        const age = Date.now() - updatedAt;
        
        if (age > STUCK_THRESHOLD_MS) {
          // 自动重置为 pending
          data.status = 'pending';
          data.updated_at = new Date().toISOString();
          if (!data.history) data.history = [];
          data.history.push({
            timestamp: data.updated_at,
            action: 'warden_auto_reset',
            agent: 'WARDEN',
            model: 'bailian/qwen3.5-plus',
            notes: `任务卡在 ${data.status} 超过 ${Math.round(age / 60000)} 分钟，自动重置为 pending`
          });
          fs.writeFileSync(path.join(TASKS_DIR, file), JSON.stringify(data, null, 2));
          issues.push(`🔄 重置卡住任务: ${data.task_id}（${Math.round(age / 60000)}分钟）`);
        }
      }
      
      // 3. 检测连续失败（history 中最近 3 条都是失败）
      const recentHistory = (data.history || []).slice(-3);
      const allFailed = recentHistory.length >= 3 && recentHistory.every(h => h.result === 'failure');
      if (allFailed) {
        issues.push(`🚨 任务 ${data.task_id} 连续 3 次失败，需要人工介入`);
      }
      
    } catch (err) {
      issues.push(`⚠️ 读取 ${file} 失败: ${err.message}`);
    }
  }
  
  // 4. 输出状态报告
  const tasks = files.map(f => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8'));
      return `${d.task_id}: ${d.status} (iter ${d.current_iteration || 0})`;
    } catch { return `${f}: error`; }
  });
  
  console.log(`📋 任务状态:\n  ${tasks.join('\n  ')}`);
  
  if (issues.length > 0) {
    console.log(`\n⚠️ 发现 ${issues.length} 个问题:`);
    issues.forEach(i => console.log(`  ${i}`));
  } else {
    console.log('\n✅ 一切正常');
  }
}

main();
