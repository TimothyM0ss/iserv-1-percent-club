# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

This is a Node.js project (Node 20 or later, CommonJS), not .NET. Ignore the global .NET and `dotnet test` guidance here. Dependencies are Express 5, Socket.IO, Helmet and Multer. The front end is plain browser JavaScript in `public/`, with no build step and no framework.

## Commands

```bash
npm install
npm start                 # http://localhost:3000, admin at /admin
npm run dev               # node --watch server.js
npm test                  # node --test "test/*.test.js"
node --test test/game.test.js                      # one file
node --test --test-name-pattern="full game" test/  # one test by name
```

There is no linter or build step. Without `ADMIN_PASSWORD`, the server prints a temporary password at start-up. With `NODE_ENV=production`, it refuses to start without one.

## Architecture

A real-time quiz. One in-memory `Game` runs per process. Run a single instance only.

- `server.js` exports `createServer({ adminPassword, dataDir, questionMs, production })`. It wires Express, Socket.IO, the admin REST API (`/api/admin/*`, cookie session) and the `Game` and `Store`. Tests call this factory directly. `questionMs` is injectable so tests run in milliseconds.
- `lib/game.js` holds the game state machine: `lobby → ready → question → reveal → … → finished`. It has no I/O. Time comes from an injected `now`. It reports changes through `onChange(immediate)`.
- `lib/store.js` persists questions to `DATA_DIR/questions.json` (default `./data`, git-ignored) and stores images in `uploads/`. It validates input, sniffs image signatures, and handles export and import of question packs.
- `public/` has three clients. `index.html` and `game.js` are for players. `admin.html`, `admin.js` and `admin.css` are for the host. `screen.html`, `screen.js` and `screen.css` are a read-only big-screen view (`/screen`) for sharing in Teams. It uses the unauthenticated `/screen` socket namespace and `Game.screenView()`. `dom.js` has the `h()` element helper and number formatting.

### Data flow

1. `Game.onChange` triggers `broadcastNow` in `server.js`. Non-urgent changes are debounced by 80 ms. Phase changes pass `immediate = true`.
2. Each player socket gets `publicView()` plus its own `meView(playerId)`. The `/admin` namespace gets `adminView()`, which adds the correct answer and reason.
3. `publicView()` must never include `correctIndex` or `reason` before the `reveal` phase. This is a security rule, so keep it when you change views.
4. Players send `join` and `answer`. The admin namespace sends `start`, `next`, `reset` and `kick`.

### Rules worth knowing before editing

- **Server clock decides timing.** `answer()` rejects anything after `deadline`. A `setTimeout` calls `lock()` when time expires.
- **Players are identified by a token.** `join` accepts a stored token to reconnect to the same player. Players who disconnect in the lobby are removed after 15 seconds. Players who disconnect mid-game are kept.
- **Late joiners are spectators.** Anyone who joins outside the `lobby` phase cannot answer.
- **Question order is derived.** `Store.list()` sorts by `difficulty` descending (the "% who get it right" value), then by `order`. `gameQuestions()` takes the selected questions in that order. A game needs exactly 5 (`QUESTIONS_PER_GAME`).
- **Answers can carry images.** Each answer has `text` and an optional `image`. An answer needs at least one of them. `Store.resolveAnswers` writes new uploads and cleans up files if validation fails. Image files are deleted when a question is updated, removed or replaced by an import.
- **Uploads reach the server two ways.** The admin form posts multipart data (`image`, `answerImage0`–`answerImage3`, plus a JSON `data` field). Import packs carry base64 `imageData`.
- **Hosting limits.** The Render free tier clears the disk on each deploy, and game state is in memory. See `README.md` for the backup and restore workflow and the deploy steps.

## Tests

- `test/game.test.js` tests the `Game` rules with an injected clock.
- `test/store.test.js` tests validation and the image lifecycle.
- `test/server.test.js` plays a full game over real sockets with `socket.io-client` against a temporary data directory.
