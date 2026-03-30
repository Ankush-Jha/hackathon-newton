# Newton School for VS Code

> AI-powered companion for Newton School students — courses, progress, practice problems, and schedule inside GitHub Copilot.

## ✨ Features

### 🤖 Zero-Config Copilot Integration
The Newton School MCP server is **automatically registered** when you install this extension. No manual `mcp.json` editing required. Just install and start asking questions in Copilot Chat!

### 💬 Ask Copilot Anything About Your Courses

Open Copilot Chat and try:

| Query | What happens |
|-------|------------|
| *"What assignments are due this week?"* | Shows pending assignments with deadlines |
| *"Give me 5 medium array problems from Google"* | Searches practice problems by topic, difficulty, company |
| *"How am I doing in DSA?"* | Shows topic-wise completion percentage |
| *"What's today's Question of the Day?"* | Shows QOTD title, difficulty, and your streak |
| *"What's my rank on the leaderboard?"* | Shows your position and top performers |
| *"Which lectures have I missed?"* | Lists recent lectures with recording links |
| *"What's on my calendar this week?"* | Shows upcoming events and lectures |

### 📊 Status Bar
- **🔥 QOTD Streak** — See your Question of the Day streak at a glance
- **📚 Next Class** — Know when your next lecture is
- **🟢 Connection Status** — Instantly know if you're connected

### 🎓 Dashboard Sidebar
Click the Newton School icon in the Activity Bar for quick-action buttons that open Copilot with common queries.

### 🚀 Guided Onboarding
First-time users get a 3-step walkthrough to connect their account, ask their first question, and explore the dashboard.

## 📋 Requirements

| Requirement | Details |
|-------------|---------|
| **VS Code** | v1.102.0 or later |
| **Node.js** | v18 or later |
| **Platform** | macOS (Apple Silicon recommended) |
| **Copilot** | GitHub Copilot subscription (for Agent Mode) |
| **Account** | Newton School student account |

## 🔧 Installation

1. Install from the VS Code Marketplace (search "Newton School")
2. The extension activates automatically
3. Open Copilot Chat and ask any Newton-related question
4. On first use, your browser will open for Newton School login
5. Done! ✅

## 🛠 Available Commands

| Command | Description |
|---------|-------------|
| `Newton: Log In` | Connect your Newton School account |
| `Newton: Log Out` | Disconnect your account |
| `Newton: Open Dashboard` | Open the sidebar dashboard |
| `Newton: Refresh Status` | Refresh status bar data |

## 🔌 MCP Tools Available

This extension exposes **18 tools** via the Model Context Protocol:

| Tool | Description |
|------|-------------|
| `list_courses` | List enrolled courses and semesters |
| `get_me` | Get your profile information |
| `get_course_overview` | XP, rank, level, milestones |
| `get_subject_progress` | Topic-wise completion per subject |
| `get_assignments` | Assignments and deadlines |
| `get_assessments` | MCQ quiz scores |
| `get_recent_lectures` | Past lectures with recordings |
| `get_lecture_details` | Full lecture notes and recording |
| `get_upcoming_schedule` | Upcoming lectures and events |
| `get_calendar` | Calendar for specific dates |
| `search_practice_questions` | Search problems by topic/difficulty |
| `get_arena_filters` | Available topics and companies |
| `get_arena_stats` | Practice statistics |
| `get_question_of_the_day` | Today's QOTD + streak |
| `get_qotd_history` | Past QOTDs and leaderboard |
| `get_leaderboard` | Rankings and top performers |
| `logout` | Clear credentials |

## ⚠️ Platform Limitation

Currently, the Newton School MCP server only supports **macOS**. Windows and Linux support is on the roadmap. On unsupported platforms, the extension will display a friendly message.

## 📄 License

MIT
