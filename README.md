# LaunchPad

Entrepreneur's Project Tracker & GitHub Discovery Platform

## Features

- 📊 **Dashboard** - Track all your projects in one place
- 📁 **My Projects** - Full CRUD for project management
- 🐙 **GitHub Import** - Bulk import repos from your GitHub account
- 🦞 **GitHubNeo** - GitHub-style repository manager with sync status
- 🔍 **Discover** - Find trending GitHub projects and templates
- 📝 **Build Logs** - Track progress and milestones
- 🔄 **Sync Status** - Monitor git status (synced/ahead/behind/dirty)

## Tech Stack

- **Frontend:** Vanilla JavaScript, CSS
- **Backend:** Node.js, Express
- **Database:** SQLite (better-sqlite3)
- **Imports:** Octokit (GitHub API)

## Setup

```bash
npm install
npm start
```

Runs on http://localhost:3020

## Database Schema

Projects tracked with:
- Name, description, tech stack
- Status (idea/building/launched/paused)
- Local path & GitHub URL
- Sync status tracking
- Build logs & metrics

Built with ❤️ for tracking the journey from idea to launch.
