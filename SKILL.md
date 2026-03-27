---
name: auto-evolution
description: "Multi-agent auto-evolution system — orchestrate review-execute-audit loops to autonomously complete complex tasks. A single coordinator agent drives the loop by spawning reviewer and executor sub-agents. Break goals into subtasks, auto-iterate with quality gates, and auto-package results. Use when: user wants autonomous task execution, self-improving agent workflows, or automated code generation with review gates."
---

# auto-evolution

**Category:** Agent Orchestration / Meta-Skill
**Version:** 0.5.7

---

## Description

**Multi-agent auto-evolution system** — a single coordinator agent drives an autonomous review → execute → audit loop by spawning sub-agents for each role.

This is a **meta-skill**: it doesn't handle business logic. It orchestrates the loop so complex tasks get completed autonomously with built-in quality gates.

### Architecture (2 Roles)

| Role | How It Works | Recommended Model |
|------|-------------|-------------------|
| **Coordinator** | Your main agent. Runs on a heartbeat/cron. Scans tasks, spawns sub-agents for review and execution. | Any (drives the loop) |
| **Sub-agents** | Spawned on demand by the coordinator for specific roles (reviewer, executor, auditor). | Reviewer: strong model (Sonnet/GPT-4o). Executor: cost-effective (Qwen/Haiku). |

**Optional:** A monitor script can run on a separate timer to detect stuck tasks and clean orphaned locks.

**Cost control:** Only the reviewer/auditor sub-agents need a strong model. The coordinator and executor can use cheap models. Spawn-based — sub-agents only run when needed.

---

## Core Modules

| File | Purpose |
|------|---------|
| `scripts/heartbeat-coordinator.js` | Coordinator: scan pending → output review/execution prompts |
| `scripts/monitor.js` | Monitor: detect stuck tasks → auto-reset, clean locks |
| `scripts/pack-skill.js` | Package completed tasks → skill directories |
| `config/task-schema.json` | Task file JSON Schema |

---

## Setup

### 1. Initialize workspace directories

```bash
mkdir -p evolution/tasks evolution/archive evolution/test-results
```

### 2. Create a task

Copy and edit the example:
```bash
cp skills/auto-evolution/references/task-example.json evolution/tasks/task-001.json
```

### 3. Configure the coordinator heartbeat

**Option A: Via HEARTBEAT.md** (recommended — runs in your main agent's heartbeat loop)

Add to your agent's `HEARTBEAT.md`:
```markdown
## Evolution Loop
1. Run `node skills/auto-evolution/scripts/heartbeat-coordinator.js`
2. If a pending task is found, spawn a reviewer sub-agent with the output prompt
3. Apply the review result, then spawn an executor sub-agent
4. Apply the execution result
5. Repeat next heartbeat
```

**Option B: Via cron** (standalone)
```bash
openclaw cron add --agent <your-agent> \
  --name "evolution-coordinator" \
  --every 5m \
  --session isolated \
  --timeout-seconds 300 \
  --message "Evolution heartbeat: scan pending tasks, spawn reviewer sub-agent."
```

### 4. (Optional) Configure the monitor

```bash
openclaw cron add --agent <any-agent> \
  --name "evolution-monitor" \
  --every 10m \
  --session isolated \
  --timeout-seconds 120 \
  --message "Run: node skills/auto-evolution/scripts/monitor.js"
```

### 5. Environment variables (optional)

Scripts auto-detect workspace. Override with:
```bash
export OPENCLAW_WORKSPACE=/path/to/workspace
export EVOLUTION_TASKS_DIR=/path/to/tasks
```

---

## How It Works

### Flow

```
Coordinator heartbeat fires
  → finds pending task
  → spawns Reviewer sub-agent → gets review + instructions
  → spawns Executor sub-agent → executes one subtask
  → updates task → back to pending (next subtask)
  → all subtasks done → completed → auto-packaged
```

### State Machine

```
pending → reviewing → reviewed → executing → pending (next subtask)
                                            → completed (all done)
                                            → packaged ✅
```

### Key Rules

- **One subtask per iteration** — keeps cycles fast and reviewable
- **Only mark `completed` when `history.length >= subtasks.length`**
- If reviewer API fails → wait and retry next heartbeat (never skip review)
- Monitor auto-resets tasks stuck > 10 minutes

---

## Task File Format

See `references/task-example.json` for a complete example.

Required fields:
```json
{
  "task_id": "task-001",
  "status": "pending",
  "goal": "What to build",
  "current_iteration": 0,
  "max_iterations": 10,
  "context": {
    "subtasks": ["Step 1", "Step 2", "Step 3"]
  },
  "history": []
}
```

---

## CLI Usage

```bash
# Scan tasks and output prompts
node scripts/heartbeat-coordinator.js

# Apply review result to a task
node scripts/heartbeat-coordinator.js apply-review task-001.json review-output.txt

# Apply execution result to a task
node scripts/heartbeat-coordinator.js apply-result task-001.json exec-output.txt

# Run monitor check
node scripts/monitor.js

# Package completed tasks
node scripts/pack-skill.js
```

---

## Design Philosophy

- **Coordinator-driven** — one agent runs the loop, spawns sub-agents as needed
- **Model-agnostic** — swap any model for any role; the protocol doesn't care
- **One subtask per tick** — predictable, won't timeout, easy to review
- **Self-healing** — monitor detects stuck tasks and auto-resets
- **No quality shortcuts** — reviewer down? Wait. Never skip the gate.
