# SecuFusion MCP: The Beginner's Guide

Welcome to SecuFusion! If you are new to the team, you might have noticed that this repository comes with an AI co-pilot built right into it. 

This isn't just a generic chatbot; it is a highly specialized, context-aware architectural assistant that lives in your project. This guide will explain how to set it up, how to use it, and how it "thinks."

---

## 🚀 1. Setup & Installation
SecuFusion MCP is a **Claude Desktop Plugin first**. The absolute easiest way to install it is directly through Claude Desktop without even needing to clone the codebase.

1. **Install via Claude Desktop (Recommended):**
   Open your Claude Desktop configuration file (usually found in `%APPDATA%\\Claude\\claude_desktop_config.json` on Windows or `~/Library/Application Support/Claude/claude_desktop_config.json` on Mac) and add the NPM package:
   ```json
   {
     "mcpServers": {
       "secufusion-mcp": {
         "command": "npx",
         "args": ["-y", "secufusion-mcp@latest"]
       }
     }
   }
   ```
   Restart Claude Desktop. You're done!

2. **Local Compilation & IDE Connection (Advanced/Dev Mode):**
   If you are actively developing the MCP itself, you can clone the repository and compile the plugins locally. Run these commands one by one from the root of the project:
   ```bash
   cd secufusion-dna-plugin/mcp
   npm install
   npm run build
   cd ../../secufusion-mcp
   npm install
   npm run build
   ```
   Configure your AI IDE (like Claude Code or Antigravity) to point to the built MCP servers:
   - `node absolute/path/to/secufusion-dna-plugin/mcp/dist/index.js`
   - `node absolute/path/to/secufusion-mcp/index.js`

3. **Open the Project Root:**
   Open the IDE at the root of the project. It will automatically read `.agents/claude.md` and instantly know the project's rules, architecture, and workflows.

## 📑 2. Spec-Based Development
SecuFusion is heavily **Spec-Based**. We do not believe in ad-hoc, blind coding. Every single task is anchored by a formal specification. 

When you start a task, the AI reads the global `.secufusion-project-spec.json` (which holds your golden rules and constraints) and generates a strict, task-level specification (Acceptance Criteria, boundaries) before a single line of code is written.

## 🛠️ 3. The 4 Magic Commands
We have streamlined the entire development lifecycle into 4 simple commands. Just type these into the AI chat box to get work done:

### 1. `sfn:init` (The DNA Mapper)
**When to use:** The very first time you clone the repo, or if the architecture has drastically changed.
**What happens under the hood:** The AI calls the DNA Discovery engine to scan the entire codebase. It maps out all microservices, Kafka endpoints, database entities, and configurations. It saves this "DNA" so it never has to guess how the project works.

### 2. `sfn:plan [Task Description or Jira Ticket]`
**When to use:** When you are starting a new feature or bug fix.
**What happens under the hood:** 
- The AI provisions a dedicated workspace folder for your task (`manage_task`).
- It loads the project DNA (`prime_session`).
- It categorizes the architectural boundaries of your work (`classify_task`).
- It switches to the **Planner Persona** to write a strict, step-by-step implementation plan and *waits for your approval.*

### 3. `sfn:code`
**When to use:** After you have approved the plan.
**What happens under the hood:** The AI switches to the **Coder Persona** and writes the code precisely as planned. If it runs into a roadblock, it uses its "Rejected Patterns" memory to ensure it doesn't repeat past mistakes.

### 4. `sfn:review`
**When to use:** When the coding is done and you want to ensure it meets our strict standards before opening a Pull Request.
**What happens under the hood:** The AI triggers a standalone CLI script (`sfn-pr-check.ts`) that runs 5 zero-tolerance mechanical checks (like Tenant Isolation and N+1 queries). If it passes, it switches to the **Reviewer Persona** for a final AI sign-off.

---

## 🧠 3. How the AI Reasons (The ReAct Framework)

You might wonder how the AI guarantees it won't just hallucinate bad code. 

Under the hood, the AI is strictly bound by the **ReAct (Reason, Observe, Act) Framework**, which is codified in our `.agents/AGENTS.md` router.

Whenever you ask it to do something, it is physically not allowed to just "start typing code." It must follow this loop:

1. **Reason:** Deeply analyze the problem statement. Formulate a hypothesis based on the loaded DNA.
2. **Observe:** Look at the surrounding code, the project's Golden Rules, and the Blast Radius of the proposed change.
3. **Act:** Only after Reasoning and Observing is it allowed to use tools (like `classify_task` or writing code).

By forcing the AI through this ReAct loop, it acts like a senior architect carefully planning a change, rather than a junior developer rushing to write code.

---
**💡 Welcome to the team! Just type `sfn:init` to get started.**
