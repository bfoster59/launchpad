// LaunchPad Learn — GitHub Curriculum
//
// CommonJS module so the server can require() it directly. Frontend gets the
// same data via GET /api/learn/curriculum.
//
// LESSON SHAPE — every lesson must follow this:
//   {
//     id: 'B1',                       // unique slug
//     level: 'basic'|'adequate'|'expert',
//     module: 'foundation'|...,       // groups lessons within a level
//     title: 'What is Git?',
//     summary: 'Short hook — appears on the lesson card',
//     xp: 50,                         // awarded on first completion
//     badge_id: 'git-newbie',         // optional — awarded on completion
//     content: [                      // array of content blocks
//       { type: 'text', md: 'Markdown body…' },
//       { type: 'code', lang: 'bash', code: 'git init' },
//       { type: 'callout', kind: 'tip'|'warn'|'info', md: '…' }
//     ],
//     quiz: [
//       { type: 'mcq', q: 'Question?', choices: ['a','b','c','d'], answer: 1, explain: 'Why' },
//       { type: 'short', q: 'Type the command', answer: 'git init',
//         accept: ['git init'], explain: '…' }
//     ],
//     challenge: {
//       type: 'command-sandbox'|'order-steps'|'choose-path',
//       prompt: 'Type the command to stage all changes:',
//       expected: 'git add -A',           // canonical
//       accept: ['git add -A','git add .'],
//       hint: 'Use the -A or --all flag',
//       // for order-steps:
//       // steps: ['Init repo', 'Add files', 'Commit', 'Push'],
//       // for choose-path:
//       // choices: [{label, correct:true, explain}, ...]
//     }
//   }
//
// Adding a lesson is purely additive — push to the right module.lessons[].

const BADGES = {
    'git-newbie':       { name: 'Git Newbie',       emoji: '🌱', desc: 'Started your git journey' },
    'first-commit':     { name: 'First Commit',     emoji: '📝', desc: 'Made your first commit' },
    'remote-rookie':    { name: 'Remote Rookie',    emoji: '🌐', desc: 'Connected local to GitHub' },
    'log-reader':       { name: 'Log Reader',       emoji: '🔎', desc: 'Read history like a pro' },
    'basic-graduate':   { name: 'Basic Graduate',   emoji: '🎓', desc: 'Completed all Basic lessons' },
    'branch-boss':      { name: 'Branch Boss',      emoji: '🌿', desc: 'Mastered branching' },
    'merge-master':     { name: 'Merge Master',     emoji: '🔀', desc: 'Merged without breaking a sweat' },
    'conflict-slayer':  { name: 'Conflict Slayer',  emoji: '⚔️', desc: 'Resolved a merge conflict' },
    'pr-pro':           { name: 'PR Pro',           emoji: '✅', desc: 'Crafted a pull request' },
    'gitignore-guru':   { name: 'Gitignore Guru',   emoji: '🚫', desc: 'Tamed your tracked files' },
    'stash-saver':      { name: 'Stash Saver',      emoji: '💾', desc: 'Stashed work in progress' },
    'adequate-graduate':{ name: 'Adequate Grad',    emoji: '🏆', desc: 'Completed Adequate level' },
    'rebase-tactician': { name: 'Rebase Tactician', emoji: '🎯', desc: 'Rewrote history cleanly' },
    'time-traveler':    { name: 'Time Traveler',    emoji: '⏱',  desc: 'Used cherry-pick + reflog' },
    'actions-architect':{ name: 'Actions Architect',emoji: '⚙️', desc: 'Wrote a GitHub Action' },
    'expert-graduate':  { name: 'Expert Graduate',  emoji: '👑', desc: 'Reached Expert level' }
};

// ===========================================================================
// BASIC — Foundation. The bare minimum to be effective with git + GitHub.
// ===========================================================================

const basicLessons = [
    {
        id: 'B1',
        level: 'basic',
        module: 'foundation',
        title: 'What Is Git, and Why Use It?',
        summary: 'Version control in 5 minutes — what changes, who changed it, and how to undo.',
        xp: 50,
        badge_id: 'git-newbie',
        content: [
            { type: 'text', md: 'Git is a **version control system**. It tracks every change to your project so you can:\n\n- Roll back to any earlier state\n- See who changed what, and when\n- Work on multiple features at once without stepping on each other\n- Collaborate with other developers safely' },
            { type: 'callout', kind: 'info', md: 'Think of git as **save points in a video game** — except you can name each save, branch off into alternate timelines, and merge them back together.' },
            { type: 'text', md: '**GitHub** is a website that hosts git repositories online. Git works fine without GitHub (it\'s 100% local), but GitHub adds:\n\n- A backup of your code in the cloud\n- A visual UI for diffs, history, and discussions\n- Collaboration tools: pull requests, issues, code review\n- Free hosting for public projects' },
            { type: 'code', lang: 'bash', code: '# Check if git is installed\ngit --version\n\n# Should print something like:\n# git version 2.45.1' }
        ],
        quiz: [
            { type: 'mcq',
              q: 'What does git track?',
              choices: ['Only the latest version of your files', 'Every change to your files over time', 'Only files smaller than 1MB', 'Only text files'],
              answer: 1,
              explain: 'Git records every change as a commit, building a complete history.'
            },
            { type: 'mcq',
              q: 'Is git the same as GitHub?',
              choices: ['Yes, they\'re identical', 'No — git is the tool, GitHub is a hosting service', 'Yes, but GitHub is paid', 'No — git is for Linux only'],
              answer: 1,
              explain: 'Git is the version control tool itself. GitHub is one of several places (along with GitLab, Bitbucket, etc.) where you can host git repos online.'
            }
        ],
        challenge: {
            type: 'command-sandbox',
            prompt: 'Type the command to check what version of git you have installed:',
            expected: 'git --version',
            accept: ['git --version', 'git -v'],
            hint: 'It uses a double-dash flag, like most "show info" commands.'
        }
    },

    {
        id: 'B2',
        level: 'basic',
        module: 'foundation',
        title: 'Repos, Commits, and the Working Tree',
        summary: 'The three places your code lives: working tree, staging area, repository.',
        xp: 50,
        content: [
            { type: 'text', md: 'A **repository** (repo) is a folder that git is tracking. Inside it, your files exist in three places at once:' },
            { type: 'text', md: '1. **Working tree** — the actual files on disk you\'re editing right now.\n2. **Staging area** (a.k.a. the index) — a holding area for changes you\'ve marked ready to commit.\n3. **Repository** — the permanent committed history (lives in the hidden `.git/` folder).' },
            { type: 'callout', kind: 'tip', md: 'The staging area exists so you can craft *exactly* what each commit contains. Edit five files, but only commit two? No problem.' },
            { type: 'text', md: 'A **commit** is a saved snapshot. Each commit has:\n- A unique ID (a SHA hash like `4a3b9f2`)\n- An author, timestamp, and message\n- A pointer to the previous commit (parent), forming a chain' },
            { type: 'code', lang: 'bash', code: 'working tree → (git add) → staging area → (git commit) → repository' }
        ],
        quiz: [
            { type: 'mcq',
              q: 'What\'s the staging area for?',
              choices: ['Files that are too small to commit', 'A backup of files you\'ve deleted', 'Holding the changes you\'ve marked ready for the next commit', 'Auto-saving every 30 seconds'],
              answer: 2,
              explain: 'Staging lets you pick exactly which changes go into your next commit, even from the same file.'
            },
            { type: 'short',
              q: 'What hidden folder does git use to store repository data?',
              answer: '.git',
              accept: ['.git', '.git/'],
              explain: 'Every git repo has a hidden `.git/` directory at its root.'
            }
        ],
        challenge: {
            type: 'order-steps',
            prompt: 'Put these git stages in the order code moves through them:',
            steps: ['Working tree (you edit files)', 'Staging area (git add)', 'Repository (git commit)'],
            hint: 'Edit → mark for commit → save the snapshot.'
        }
    },

    {
        id: 'B3',
        level: 'basic',
        module: 'foundation',
        title: 'Your First Commit',
        summary: 'init, status, add, commit — the four commands you\'ll use a thousand times.',
        xp: 75,
        badge_id: 'first-commit',
        content: [
            { type: 'text', md: 'Time for the core loop. Every commit you ever make follows the same pattern:' },
            { type: 'code', lang: 'bash', code: '# 1. Start a new repo (only once per project)\ngit init\n\n# 2. See what changed\ngit status\n\n# 3. Stage the changes you want\ngit add README.md           # one file\ngit add -A                  # all changes\n\n# 4. Commit them with a message\ngit commit -m "Add README"' },
            { type: 'callout', kind: 'tip', md: 'A good commit message is a complete sentence in the imperative mood: **"Add README"**, not **"added the readme yo"**. Pretend git is autocompleting the sentence "If applied, this commit will…"' },
            { type: 'text', md: '`git status` is your best friend. Run it before AND after every git command. It tells you:\n- What\'s changed\n- What\'s staged\n- What branch you\'re on' }
        ],
        quiz: [
            { type: 'short',
              q: 'What command initializes a new git repo in the current folder?',
              answer: 'git init',
              accept: ['git init'],
              explain: 'Creates the hidden `.git/` directory and starts tracking the folder.'
            },
            { type: 'short',
              q: 'What flag on `git commit` lets you supply a one-line message inline?',
              answer: '-m',
              accept: ['-m', '--message'],
              explain: '`git commit -m "your message"` skips the editor.'
            },
            { type: 'mcq',
              q: 'You edited 5 files but only want to commit 2. What do you do?',
              choices: ['Delete the other 3 first', 'Use `git add` only on the 2 you want, then commit', 'Run `git commit -m` with a long message', 'Make 5 separate commits, one per file'],
              answer: 1,
              explain: 'Staging is selective — `git add` only the files you want this commit to include.'
            }
        ],
        challenge: {
            type: 'command-sandbox',
            prompt: 'You edited several files. Type the command to stage ALL of them:',
            expected: 'git add -A',
            accept: ['git add -A', 'git add --all', 'git add .'],
            hint: 'A single flag means "everything". Either -A, --all, or the . shortcut work.'
        }
    },

    {
        id: 'B4',
        level: 'basic',
        module: 'foundation',
        title: 'Reading Your History with git log',
        summary: 'See every commit ever made, who made it, and what changed.',
        xp: 50,
        badge_id: 'log-reader',
        content: [
            { type: 'text', md: '`git log` shows your commit history, newest first.' },
            { type: 'code', lang: 'bash', code: '# Full log (press q to exit the pager)\ngit log\n\n# Compact one-line view\ngit log --oneline\n\n# Show the file changes per commit\ngit log -p\n\n# Filter to commits from a specific author\ngit log --author="Bob"\n\n# Last 5 commits, with a graph of branches\ngit log --oneline --graph -5' },
            { type: 'callout', kind: 'tip', md: 'When the log is too long, you\'re inside a pager. Press `q` to quit, `/` to search, space to scroll.' },
            { type: 'text', md: 'Each commit has a unique **SHA hash** like `4a3b9f2c1e…`. You only need the first 7 characters to reference it (`4a3b9f2`).' }
        ],
        quiz: [
            { type: 'mcq',
              q: 'How do you see a compact, one-line-per-commit history?',
              choices: ['git log --short', 'git log --oneline', 'git log -1', 'git log --quiet'],
              answer: 1,
              explain: '`--oneline` collapses each commit to a single line: SHA + message.'
            },
            { type: 'short',
              q: 'How many characters of a SHA hash do you typically need to uniquely reference a commit?',
              answer: '7',
              accept: ['7', 'seven'],
              explain: '7 characters is the conventional short SHA — usually unique enough.'
            }
        ],
        challenge: {
            type: 'command-sandbox',
            prompt: 'Show only the last 3 commits as one line each, with a graph:',
            expected: 'git log --oneline --graph -3',
            accept: ['git log --oneline --graph -3', 'git log --graph --oneline -3', 'git log -3 --oneline --graph'],
            hint: 'Three flags: --oneline, --graph, and -N for limit.'
        }
    },

    {
        id: 'B5',
        level: 'basic',
        module: 'foundation',
        title: 'Connecting to GitHub: clone, push, pull',
        summary: 'Get code from GitHub, send your changes back, stay in sync.',
        xp: 100,
        badge_id: 'remote-rookie',
        content: [
            { type: 'text', md: 'A **remote** is a copy of your repo hosted somewhere else — usually GitHub. By convention, the default remote is named `origin`.' },
            { type: 'text', md: '**Clone** = download a remote repo for the first time:' },
            { type: 'code', lang: 'bash', code: 'git clone https://github.com/bfoster59/launchpad.git\ncd launchpad' },
            { type: 'text', md: '**Push** = send your commits to the remote:' },
            { type: 'code', lang: 'bash', code: 'git push origin master' },
            { type: 'text', md: '**Pull** = download new commits from the remote:' },
            { type: 'code', lang: 'bash', code: 'git pull origin master' },
            { type: 'callout', kind: 'warn', md: '**Always pull before you push** when working with others — otherwise your push gets rejected because the remote has commits you don\'t.' },
            { type: 'text', md: '**Authentication:** GitHub uses HTTPS + a Personal Access Token (PAT) or SSH keys. The easiest path on Windows: install the GitHub CLI (`gh`) and run `gh auth login` — it handles everything automatically.' }
        ],
        quiz: [
            { type: 'mcq',
              q: 'What\'s the conventional name for the default remote?',
              choices: ['main', 'origin', 'remote', 'github'],
              answer: 1,
              explain: '`origin` is git\'s default name for the remote you cloned from.'
            },
            { type: 'mcq',
              q: 'You\'re working with a teammate. What should you do BEFORE pushing your commits?',
              choices: ['Run git status', 'Run git pull to grab their latest changes', 'Run git init again', 'Reboot your machine'],
              answer: 1,
              explain: 'Pulling first ensures you have their commits and prevents push rejections.'
            },
            { type: 'short',
              q: 'What single command downloads a repo from GitHub for the first time?',
              answer: 'git clone',
              accept: ['git clone'],
              explain: '`git clone <url>` downloads the entire repo + history.'
            }
        ],
        challenge: {
            type: 'choose-path',
            prompt: 'You committed locally but need to send those commits to GitHub. What command do you run?',
            choices: [
                { label: 'git push', correct: true, explain: 'Correct! `git push` sends your local commits to the remote.' },
                { label: 'git pull', correct: false, explain: 'Pull RECEIVES commits — you want push to SEND them.' },
                { label: 'git commit --send', correct: false, explain: 'No such flag. Commit is purely local; push is a separate command.' },
                { label: 'git upload', correct: false, explain: 'No such command in git.' }
            ],
            hint: 'Push sends, pull receives. Easy to mix up.'
        }
    },

    {
        id: 'B6',
        level: 'basic',
        module: 'foundation',
        title: 'Basic Recap & Mastery Quiz',
        summary: 'Test what you\'ve learned. Pass to earn the Basic Graduate badge.',
        xp: 100,
        badge_id: 'basic-graduate',
        content: [
            { type: 'text', md: 'You\'ve made it through the foundation. Quick recap of the everyday flow:' },
            { type: 'code', lang: 'bash', code: '# Daily loop\ngit status                    # what changed?\ngit add -A                    # stage everything\ngit commit -m "fix: bug X"    # snapshot it\ngit pull                      # get teammate changes\ngit push                      # send mine up' },
            { type: 'callout', kind: 'info', md: 'Pass this quiz to earn the **🎓 Basic Graduate** badge and unlock the **Adequate** level.' }
        ],
        quiz: [
            { type: 'mcq',
              q: 'In the standard flow, what comes FIRST?',
              choices: ['git push', 'git commit', 'git status (look before you leap)', 'git init'],
              answer: 2,
              explain: 'Always run git status first to see what\'s actually different.'
            },
            { type: 'mcq',
              q: 'You ran `git commit` but forgot to `git add` the file you wanted. What happened?',
              choices: ['It committed anyway', 'It committed nothing for that file', 'It deleted the file', 'It crashed'],
              answer: 1,
              explain: 'commit only includes what\'s staged. Unstaged changes are skipped.'
            },
            { type: 'mcq',
              q: 'Which of these does NOT touch the network?',
              choices: ['git push', 'git pull', 'git clone', 'git commit'],
              answer: 3,
              explain: 'commit is purely local. Only push/pull/clone/fetch hit the network.'
            }
        ],
        challenge: {
            type: 'order-steps',
            prompt: 'Put the daily git flow in order:',
            steps: ['git status (see what changed)', 'git add -A (stage)', 'git commit -m "msg" (snapshot)', 'git pull (get teammate updates)', 'git push (send mine up)'],
            hint: 'Look → stage → commit → sync down → sync up.'
        }
    }
];

// ===========================================================================
// ADEQUATE — Working knowledge. Branches, merges, conflicts, PRs.
// ===========================================================================

const adequateLessons = [
    {
        id: 'A1',
        level: 'adequate',
        module: 'branching',
        title: 'Branches: Parallel Universes for Your Code',
        summary: 'Work on a feature without breaking master. Switch back and forth instantly.',
        xp: 100,
        badge_id: 'branch-boss',
        content: [
            { type: 'text', md: 'A **branch** is a movable pointer to a commit. Branches let you work on multiple things in parallel without them tangling.' },
            { type: 'code', lang: 'bash', code: '# See what branches exist + which one you\'re on\ngit branch\n\n# Create a new branch and switch to it\ngit switch -c feature/login    # modern (recommended)\ngit checkout -b feature/login   # older, equivalent\n\n# Switch between branches\ngit switch master\ngit switch feature/login\n\n# Delete a branch (only works if it\'s merged)\ngit branch -d old-feature' },
            { type: 'callout', kind: 'tip', md: '**Branch naming convention:** `feature/login`, `fix/typo`, `chore/upgrade-deps`. The slash isn\'t literal nesting — it\'s just a visual prefix.' },
            { type: 'text', md: '**Why branches?**\n- Try a risky idea without breaking the main code\n- Have multiple PRs in flight at once\n- Switch tasks mid-flow without losing work' }
        ],
        quiz: [
            { type: 'short',
              q: 'What\'s the modern command to create AND switch to a new branch called `feature/x`?',
              answer: 'git switch -c feature/x',
              accept: ['git switch -c feature/x', 'git checkout -b feature/x'],
              explain: '`git switch -c` is the newer, clearer command. `git checkout -b` does the same thing.'
            },
            { type: 'mcq',
              q: 'You\'re on branch `feature/login`. You run `git commit`. Where does the commit go?',
              choices: ['On master', 'On feature/login', 'On both', 'In limbo until you merge'],
              answer: 1,
              explain: 'Commits land on the branch you\'re currently on. master is unaffected.'
            }
        ],
        challenge: {
            type: 'command-sandbox',
            prompt: 'You\'re on master. Create AND switch to a new branch named "feature/auth":',
            expected: 'git switch -c feature/auth',
            accept: ['git switch -c feature/auth', 'git checkout -b feature/auth'],
            hint: 'Two flags: -c creates, the branch name comes after.'
        }
    },

    {
        id: 'A2',
        level: 'adequate',
        module: 'branching',
        title: 'Merging: Bringing Branches Back Together',
        summary: 'Fast-forward vs. three-way merges, and when each happens.',
        xp: 100,
        badge_id: 'merge-master',
        content: [
            { type: 'text', md: 'Merging combines a branch\'s commits back into another branch. Two flavors:' },
            { type: 'text', md: '**Fast-forward merge:** master hasn\'t moved since you branched. Git just slides master\'s pointer forward. Clean, no merge commit.\n\n**Three-way merge:** master moved (someone else committed). Git creates a new "merge commit" that has TWO parents — your branch tip + master\'s tip.' },
            { type: 'code', lang: 'bash', code: '# Switch to the destination (where you want changes to land)\ngit switch master\n\n# Merge the feature branch in\ngit merge feature/login\n\n# Refuse non-fast-forward (force a clean linear history)\ngit merge --ff-only feature/login\n\n# Force a merge commit even when fast-forward is possible\ngit merge --no-ff feature/login' },
            { type: 'callout', kind: 'info', md: 'Most teams prefer **`--no-ff`** for feature branches because the merge commit visibly groups all the feature\'s commits into one logical unit on master.' }
        ],
        quiz: [
            { type: 'mcq',
              q: 'When does git do a fast-forward merge instead of creating a merge commit?',
              choices: ['Always', 'When the destination branch hasn\'t moved since you branched', 'When the feature branch has only one commit', 'When you push first'],
              answer: 1,
              explain: 'Fast-forward is possible only when there\'s no divergent history.'
            },
            { type: 'short',
              q: 'What flag forces git to refuse the merge if a fast-forward isn\'t possible?',
              answer: '--ff-only',
              accept: ['--ff-only'],
              explain: '--ff-only protects you from accidentally creating merge commits when you wanted a clean linear history.'
            }
        ],
        challenge: {
            type: 'choose-path',
            prompt: 'You\'re on `feature/x` with 3 commits. You want to merge into master, but force a merge commit so the feature is grouped clearly. What do you do?',
            choices: [
                { label: 'git switch master && git merge --no-ff feature/x', correct: true, explain: 'Switch to the destination first, then merge with --no-ff to force a merge commit.' },
                { label: 'git switch master && git merge --ff-only feature/x', correct: false, explain: '--ff-only does the OPPOSITE — it refuses if a merge commit would be needed.' },
                { label: 'git merge master into feature/x', correct: false, explain: 'No such syntax. You always switch to the destination first.' },
                { label: 'git push --merge', correct: false, explain: 'No such command. Merging happens locally before pushing.' }
            ],
            hint: 'Switch to destination, then merge with the flag that forces a merge commit.'
        }
    },

    {
        id: 'A3',
        level: 'adequate',
        module: 'collaboration',
        title: 'Resolving Merge Conflicts',
        summary: 'When two branches edit the same lines, git asks you to pick. Don\'t panic.',
        xp: 125,
        badge_id: 'conflict-slayer',
        content: [
            { type: 'text', md: 'A **merge conflict** happens when two branches changed the SAME lines of the SAME file in different ways. Git can\'t pick automatically — it asks you.' },
            { type: 'text', md: 'When a merge conflicts, git pauses and adds conflict markers into the affected files:' },
            { type: 'code', lang: 'bash', code: '<<<<<<< HEAD\nThe color is blue.\n=======\nThe color is green.\n>>>>>>> feature/colors' },
            { type: 'text', md: '**Above `=======`** is YOUR side (the branch you\'re merging INTO). **Below** is THEIR side (the incoming branch).' },
            { type: 'text', md: 'To resolve:\n1. Edit the file: pick one side, the other, or combine them.\n2. **Delete** all three marker lines (`<<<<<<<`, `=======`, `>>>>>>>`).\n3. `git add <file>` to mark it resolved.\n4. `git commit` to finish the merge (git pre-fills the message).' },
            { type: 'code', lang: 'bash', code: '# Got conflicts? See which files\ngit status\n\n# Edit, then mark resolved\ngit add path/to/conflicted-file.js\ngit commit                       # opens editor with merge message\n\n# Or abort the merge entirely\ngit merge --abort' },
            { type: 'callout', kind: 'warn', md: '**Always test after resolving.** It\'s easy to delete the markers and leave broken code. Run your tests.' }
        ],
        quiz: [
            { type: 'mcq',
              q: 'In a conflict, which side is shown ABOVE the `=======` line?',
              choices: ['The incoming branch', 'Your current branch (HEAD)', 'A random pick', 'The file as it was originally'],
              answer: 1,
              explain: 'HEAD = your current branch, shown above the divider. The incoming branch is below.'
            },
            { type: 'mcq',
              q: 'You started a merge and it conflicted. You\'ve changed your mind. What\'s the safest way to back out?',
              choices: ['Delete the .git folder', 'git reset --hard HEAD', 'git merge --abort', 'Restart the computer'],
              answer: 2,
              explain: '`git merge --abort` cleanly returns the working tree to the pre-merge state.'
            },
            { type: 'short',
              q: 'After editing conflict markers out, what command marks the file as resolved?',
              answer: 'git add',
              accept: ['git add', 'git add <file>', 'git add file'],
              explain: '`git add` on the resolved file tells git "I fixed it".'
            }
        ],
        challenge: {
            type: 'order-steps',
            prompt: 'You hit a merge conflict. Put the resolution steps in order:',
            steps: ['Run git status to see conflicted files', 'Open the files and edit the conflicted sections', 'Delete the <<<<<<<, =======, >>>>>>> markers', 'Run git add on the resolved files', 'Run git commit to finalize the merge'],
            hint: 'Identify → fix → mark resolved → finalize.'
        }
    }
];

// ===========================================================================
// EXPERT — Power skills. Rebase, cherry-pick, Actions, branch protection.
// ===========================================================================

const expertLessons = [
    {
        id: 'E1',
        level: 'expert',
        module: 'history',
        title: 'Rebasing: Rewriting History Cleanly',
        summary: 'Replay your commits on a new base. Linear history, no merge commits.',
        xp: 150,
        badge_id: 'rebase-tactician',
        content: [
            { type: 'text', md: '**Rebase** takes your branch\'s commits and "replays" them on top of another branch, as if you\'d branched off later.' },
            { type: 'text', md: 'Compare:\n\n**Merge:** keeps both timelines visible, adds a merge commit.\n**Rebase:** rewrites your branch\'s commits to look like they came AFTER the latest changes on master. Linear, no merge commit.' },
            { type: 'code', lang: 'bash', code: '# On feature/x: replay my commits on top of master\'s latest\ngit switch feature/x\ngit rebase master\n\n# Interactive rebase — squash, reorder, edit, drop commits\ngit rebase -i HEAD~5             # last 5 commits\ngit rebase -i master             # since branching from master\n\n# If conflicts during rebase\ngit add <fixed-files>\ngit rebase --continue\n# Or bail out\ngit rebase --abort' },
            { type: 'callout', kind: 'warn', md: '**Never rebase commits you\'ve already pushed and shared.** Rebase changes commit hashes; collaborators with the old hashes will have a bad day. Rule of thumb: rebase your local branch BEFORE pushing or before opening a PR.' },
            { type: 'text', md: '**Interactive rebase** lets you clean up history before pushing:\n- `pick` — keep as-is\n- `reword` — change the message\n- `squash` — fold into the previous commit\n- `fixup` — like squash but discard the message\n- `drop` — delete the commit' }
        ],
        quiz: [
            { type: 'mcq',
              q: 'What\'s the main visual difference between merge and rebase?',
              choices: ['Merge is faster', 'Rebase keeps history linear; merge preserves both branch tips with a merge commit', 'Rebase requires GitHub', 'There is no difference'],
              answer: 1,
              explain: 'Linear vs. branching shape is the visible difference; under the hood rebase rewrites commits while merge unions them.'
            },
            { type: 'mcq',
              q: 'When is rebasing DANGEROUS?',
              choices: ['On any local branch', 'On commits you\'ve already pushed and shared', 'When the branch has more than 5 commits', 'On Tuesdays'],
              answer: 1,
              explain: 'Rebase rewrites commit hashes. Anyone with the old hashes gets confused.'
            },
            { type: 'short',
              q: 'What flag starts an INTERACTIVE rebase?',
              answer: '-i',
              accept: ['-i', '--interactive'],
              explain: '`git rebase -i` opens the interactive todo list.'
            }
        ],
        challenge: {
            type: 'command-sandbox',
            prompt: 'Start an interactive rebase to clean up your last 4 commits:',
            expected: 'git rebase -i HEAD~4',
            accept: ['git rebase -i HEAD~4', 'git rebase --interactive HEAD~4'],
            hint: 'Interactive flag + the magic ref HEAD~N for "last N commits".'
        }
    },

    {
        id: 'E2',
        level: 'expert',
        module: 'history',
        title: 'Cherry-pick, Reset, and Reflog',
        summary: 'Surgical history operations. Move single commits, undo anything, recover deleted work.',
        xp: 150,
        badge_id: 'time-traveler',
        content: [
            { type: 'text', md: '**cherry-pick** copies a single commit from one branch to another:' },
            { type: 'code', lang: 'bash', code: '# I\'m on master and want commit 4a3b9f2 from feature/x\ngit cherry-pick 4a3b9f2' },
            { type: 'text', md: '**reset** moves your branch pointer to a different commit:' },
            { type: 'code', lang: 'bash', code: '# Soft: keep changes staged\ngit reset --soft HEAD~1     # undo last commit, keep its changes staged\n\n# Mixed (default): keep changes unstaged\ngit reset HEAD~1\n\n# Hard: nuke changes too — DESTRUCTIVE\ngit reset --hard HEAD~1' },
            { type: 'callout', kind: 'warn', md: '`git reset --hard` discards uncommitted work permanently. Use it only when you\'re certain.' },
            { type: 'text', md: '**reflog** is your safety net. Every move HEAD makes is logged for ~90 days, even if you "lose" commits via reset:' },
            { type: 'code', lang: 'bash', code: '# Show every HEAD movement\ngit reflog\n\n# Recover a "lost" commit\ngit reset --hard HEAD@{2}    # 2 moves ago' }
        ],
        quiz: [
            { type: 'mcq',
              q: 'You did `git reset --hard` and lost an important commit. Are you sunk?',
              choices: ['Yes — it\'s gone forever', 'No — git reflog has a record of HEAD movements; you can recover it', 'Maybe, depending on the moon phase', 'Only if you have a backup'],
              answer: 1,
              explain: 'reflog keeps a log of every HEAD move for ~90 days. Use `git reset --hard HEAD@{N}` to jump back.'
            },
            { type: 'mcq',
              q: 'You want to copy ONE specific commit (SHA `4a3b9f2`) from another branch onto your current branch. Which command?',
              choices: ['git copy 4a3b9f2', 'git cherry-pick 4a3b9f2', 'git merge 4a3b9f2', 'git checkout 4a3b9f2'],
              answer: 1,
              explain: 'cherry-pick is exactly this — copy a single commit by hash.'
            }
        ],
        challenge: {
            type: 'choose-path',
            prompt: 'You committed something you regret. The commit is local only — not pushed. You want to undo it but KEEP the changes (so you can fix and re-commit). Which command?',
            choices: [
                { label: 'git reset --soft HEAD~1', correct: true, explain: 'Correct! --soft moves the branch pointer back but keeps your changes staged.' },
                { label: 'git reset --hard HEAD~1', correct: false, explain: '--hard would NUKE your changes too. You\'d lose your work.' },
                { label: 'git revert HEAD', correct: false, explain: 'revert creates a new commit that undoes — but you wanted to discard the bad commit, not record it.' },
                { label: 'git push --force', correct: false, explain: 'push doesn\'t affect local history. Wrong tool entirely.' }
            ],
            hint: 'You want the pointer back but the changes preserved. Soft vs. hard reset is the key.'
        }
    }
];

// ===========================================================================
// CURRICULUM ROOT
// ===========================================================================

const curriculum = {
    badges: BADGES,
    levels: [
        {
            key: 'basic',
            label: 'Basic',
            tagline: 'Foundation — the bare minimum to be effective',
            color: '#60a5fa',
            xpToUnlockNext: 250,    // need 250 of 425 possible to unlock Adequate
            modules: [
                {
                    key: 'foundation',
                    label: 'Foundation',
                    lessons: basicLessons
                }
            ]
        },
        {
            key: 'adequate',
            label: 'Adequate',
            tagline: 'Working knowledge — branches, merges, PRs',
            color: '#fbbf24',
            xpToUnlockNext: 700,
            modules: [
                {
                    key: 'branching',
                    label: 'Branching & Merging',
                    lessons: adequateLessons.filter(l => l.module === 'branching')
                },
                {
                    key: 'collaboration',
                    label: 'Collaboration',
                    lessons: adequateLessons.filter(l => l.module === 'collaboration')
                }
            ]
        },
        {
            key: 'expert',
            label: 'Expert',
            tagline: 'Power skills — rewrite history, automate, protect',
            color: '#a78bfa',
            xpToUnlockNext: null,
            modules: [
                {
                    key: 'history',
                    label: 'Rewriting History',
                    lessons: expertLessons.filter(l => l.module === 'history')
                }
            ]
        }
    ],
    // Recommended Skills section (from research agent — github/anthropic real picks)
    recommendedSkills: [
        {
            key: 'github-mcp',
            tier: 'top',
            name: 'GitHub MCP Server',
            author: 'github',
            stars: '29.4k',
            repo: 'https://github.com/github/github-mcp-server',
            blurb: "GitHub's official MCP server. Connects Claude/AI tools directly to repos, issues, PRs, Actions, security findings via natural language.",
            why: "Ask plain-English questions ('show me open PRs', 'why did this Action fail') without memorizing the GitHub CLI or REST API.",
            install: {
                claudeCode: 'claude mcp add --transport http github https://api.githubcopilot.com/mcp/',
                config: '{ "servers": { "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" } } }',
                docker: 'docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server'
            }
        },
        {
            key: 'claude-code-action',
            tier: 'bonus',
            name: 'Claude Code Action',
            author: 'anthropics',
            repo: 'https://github.com/anthropics/claude-code-action',
            blurb: "Anthropic's official GitHub Action — runs Claude Code in CI to review PRs, answer issue comments, propose fixes.",
            why: 'Teaches GitHub Actions + AI code review in one drop-in workflow.',
            install: {
                workflow: 'Add as .github/workflows/claude.yml — see the repo README for the template'
            }
        },
        {
            key: 'claude-security-review',
            tier: 'bonus',
            name: 'Claude Code Security Review',
            author: 'anthropics',
            repo: 'https://github.com/anthropics/claude-code-security-review',
            blurb: 'AI security review action that comments on PRs flagging potential vulnerabilities.',
            why: 'See pull_request triggers and security scanning in one click.',
            install: {
                workflow: 'Add as .github/workflows/security-review.yml — repo README has the template'
            }
        }
    ]
};

module.exports = curriculum;
