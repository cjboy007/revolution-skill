---
name: auto-evolution
description: "Multi-agent auto-evolution system — orchestrate review, execute, audit loops across AI agents to autonomously complete complex tasks. Break goals into subtasks, auto-iterate with configurable roles (reviewer, executor, auditor, monitor), and auto-package results into skills. Use when: user wants autonomous multi-agent task execution, self-improving agent workflows, or automated code generation with review gates."
---

# auto-evolution

**Category:** Agent Orchestration / Meta-Skill
**Version:** 0.5.7

---

## Description

**Multi-agent auto-evolution system** — orchestrate multiple AI agents to autonomously complete complex tasks through review-execute-audit loops.

This is a **meta-skill**: it doesn't handle business logic directly. Instead, it coordinates agents with different roles to break down goals into subtasks and iterate until completion.

### Roles

| Role | Responsibility | Recommended Model |
|------|---------------|-------------------|
| **Designer** | Initial task design, phase planning | High-capability (e.g. Opus/o3) |
| **Reviewer** | Pre-execution review, technical audit, generate instructions | Mid-tier (e.g. Sonnet/GPT-4o) |
| **Executor** | Follow instructions, write code, run tests | Cost-effective (e.g. Qwen/Haiku) |
| **Auditor** | Post-execution quality check | Mid-tier (e.g. Sonnet/GPT-4o) |
| **Monitor** | Detect stuck tasks, clean locks, auto-reset | Cost-effective (e.g. Qwen/Haiku) |

Models are fully configurable — use whatever combination fits your budget and quality needs.

---

## Core Modules

| File | Purpose |
|------|---------|
| `scripts/heartbeat-wilson.js` | Coordinator heartbeat: scan pending → spawn reviewer |
| `scripts/heartbeat-iron.js` | Executor heartbeat: scan reviewed → execute subtask |
| `scripts/heartbeat-warden.js` | Monitor heartbeat: detect stuck tasks → auto-reset |
| `scripts/pack-skill.js` | Auto-package completed tasks → skill directories |
| `config/task-schema.json` | Task file JSON Schema |

---

## Setup

### 1. Initialize workspace directories

```bash
mkdir -p evolution/tasks evolution/archive evolution/test-results
```

### 2. Create your first task

```bash
cat > evolution/tasks/task-001.json << 'EOF'
{
  "task_id": "task-001",
  "status": "pending",
  "priority": "medium",
  "goal": "Build a CLI tool that converts CSV to JSON",
  "created_at": "2026-01-01T00:00:00Z",
  "updated_at": "2026-01-01T00:00:00Z",
  "current_iteration": 0,
  "max_iterations": 10,
  "assigned_to": "iron",
  "context": {
    "background": "We need a simple CSV→JSON converter",
    "constraints": ["Node.js only", "No external dependencies"],
    "reference_files": [],
    "subtasks": [
      "Create core parser module",
      "Add CLI argument handling",
      "Write unit tests",
      "Add error handling for malformed CSV"
    ]
  },
  "review": null,
  "result": null,
  "history": []
}
EOF
```

### 3. Configure cron heartbeats

```bash
# Coordinator heartbeat (every 3-5 min)
openclaw cron add --agent <coordinator-agent> \
  --name "evolution-coordinator" \
  --every 5m \
  --model "<your-model>" \
  --session isolated \
  --timeout-seconds 300 \
  --message "Evolution heartbeat: scan pending tasks, spawn reviewer."

# Executor heartbeat (every 3-5 min)
openclaw cron add --agent <executor-agent> \
  --name "evolution-executor" \
  --every 5m \
  --model "<your-model>" \
  --session isolated \
  --timeout-seconds 600 \
  --message "Evolution heartbeat: scan reviewed tasks, execute next subtask."

# Monitor heartbeat (every 10 min)
openclaw cron add --agent <monitor-agent> \
  --name "evolution-monitor" \
  --every 10m \
  --model "<your-model>" \
  --session isolated \
  --timeout-seconds 120 \
  --message "Evolution monitor: detect stuck tasks, clean locks, report anomalies."
```

### 4. Environment variables (optional)

Scripts auto-detect workspace location. Override with:

```bash
export OPENCLAW_WORKSPACE=/path/to/your/workspace
export EVOLUTION_TASKS_DIR=/path/to/tasks
export EVOLUTION_SKILLS_DIR=/path/to/skills
export EVOLUTION_ARCHIVE_DIR=/path/to/archive
```

---

## How It Works

### State Machine

```
pending → reviewing → reviewed → executing → pending (next subtask)
                                           → completed (all subtasks done)
                                           → packaged (auto-packaged as skill)
```

Each heartbeat cycle:
1. **Coordinator** finds a `pending` task → spawns **Reviewer**
2. **Reviewer** audits the plan, generates execution instructions → `reviewed`
3. **Executor** picks up `reviewed` task → executes one subtask → back to `pending`
4. Repeat until all subtasks complete → `completed`
5. **Pack script** archives completed tasks and generates skill output

### Key Rule

Only mark `completed` when `history.length >= subtasks.length`. Each iteration handles exactly one subtask.

### Monitor

Runs every 10 minutes:
- Tasks stuck in `reviewing`/`executing` > 10 min → auto-reset to `pending`
- Orphaned `.lock` files → cleaned
- 3+ consecutive failures → flagged for manual intervention

---

## Task File Format

```json
{
  "task_id": "task-001",
  "status": "pending",
  "priority": "medium",
  "goal": "Task objective",
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601",
  "current_iteration": 0,
  "max_iterations": 10,
  "assigned_to": "agent-name",
  "context": {
    "background": "Why this task exists",
    "constraints": ["Constraint 1"],
    "reference_files": ["/path/to/relevant/file"],
    "subtasks": ["Step 1", "Step 2", "Step 3"]
  },
  "review": {
    "verdict": "approve|revise|complete",
    "feedback": "Review comments",
    "next_instructions": {
      "summary": "What to do next",
      "current_step": 1,
      "total_steps": 3,
      "step": { "action": "...", "detail": "..." },
      "acceptance_criteria": ["Criterion 1"]
    }
  },
  "result": {
    "subtask_completed": 1,
    "summary": "What was done",
    "files_changed": []
  },
  "history": []
}
```

---

## Troubleshooting

**Task stuck in executing:**
```bash
# Reset to pending
python3 -c "
import json; d = json.load(open('evolution/tasks/task-001.json'))
d['status'] = 'pending'; json.dump(d, open('evolution/tasks/task-001.json','w'), indent=2)
"
rm evolution/tasks/*.lock
```

**Reviewer not triggering:** Check cron is running: `openclaw cron list`

**Executor timeout:** Ensure subtasks are small enough for one iteration. Increase timeout if needed.

---

## Design Philosophy

- **One subtask per iteration** — keeps each cycle fast and reviewable
- **No quality degradation** — if reviewer API fails, wait and retry; never skip review
- **Cost-efficient** — expensive models only for design/review; cheap models for execution
- **Self-healing** — monitor detects and fixes stuck states automatically
- **Composable** — swap any model or agent; the protocol is model-agnostic
