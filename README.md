# iServ 1% Club

A multiplayer quiz for the iServ team. Players answer five visual questions of rising difficulty. Each player starts with 1,000 $AGEs. A wrong answer moves those $AGEs into a shared pot. Players who answer all five correctly share the pot equally.

## Run it locally

```bash
npm install
npm start
```

Open http://localhost:3000 to play and http://localhost:3000/admin for the host controls.

If `ADMIN_PASSWORD` is not set, the server prints a temporary password at start-up. Set your own:

```powershell
$env:ADMIN_PASSWORD = "choose-a-long-passphrase"; npm start
```

## Host a game

1. Sign in at `/admin`.
2. Add questions: text, an image or both, percentage who get it right, display order, 3 or 4 answers, the correct answer and the reason.
3. Tick exactly five questions under "In game".
4. Ask players to open the home page and enter a name. Their coins appear around the table.
5. Select **Start game**. No question shows yet.
6. Select **Show question 1**. Each question locks after 20 seconds and then shows the answer and reason.
7. After question 5, select **Show results**. Select **Reset to lobby** to play again.

### Show the game on a big screen

Open `/screen` on the host's machine and share that window in Teams. It shows the join address, the pot, the timer, each question with its answers, and the reveal. It has no controls and never shows the answer before the question locks. Players still answer in their own browser at the home page.

Teams video runs a few seconds behind the server. Tell players to watch their own screen for the timer. The shared screen is for context.

### Rules the game enforces

| Rule | Behaviour |
|---|---|
| Question order | Highest "% who get it right" first (easiest), lowest last. Display order breaks ties. |
| Answer timing | The server clock decides. An answer after 20 seconds is rejected. |
| Answering | The first answer is final. No answer counts as wrong. |
| Wrong answer | The player's 1,000 $AGEs go to the pot once. They can play on but cannot win. |
| Winners | Players with 5 out of 5 split the pot equally, rounded down. With no winners, the pot is unclaimed. |
| Late joiners | Anyone joining after the host starts the game can watch but not play. |
| Reconnecting | A refresh or dropped connection keeps the player, the score and the credit. |

## Deploy to Render (free)

1. Push this folder to a Git repository that Render can read.
2. In Render, choose **New > Blueprint** and select the repository. `render.yaml` configures the service.
3. Set the `ADMIN_PASSWORD` secret when prompted.
4. Open the `onrender.com` URL. Render provides HTTPS, which the game needs for secure cookies.

Free-tier limits that matter on game day:

- **The service sleeps after about 15 minutes idle.** The first visit takes up to a minute. Open the site 5 minutes before the session.
- **The disk is cleared on every deploy and restart.** Use **Backup and restore** in the admin screen to export the question pack beforehand and import it afterwards.
- **Game state lives in memory.** Do not redeploy during a game.

Run one instance only. Game state is not shared between instances.

## Security

- The admin password comes from `ADMIN_PASSWORD`. In production the server refuses to start without it.
- Admin sessions use an HTTP-only, same-site cookie. Login attempts are rate limited.
- Uploads must be PNG, JPEG, GIF or WebP, checked by file signature, 3 MB at most. SVG is rejected.
- Correct answers and reasons never reach a player's browser before the question locks.
- Player names are rendered as text, never as HTML.

## Accessibility

- Text and controls meet WCAG AA contrast. Correct and wrong answers use icons and words as well as colour.
- Everything works by keyboard. Keys 1 to 4 or A to D choose an answer.
- Screen readers hear each question, the 10-second warning, the answer and the reason.
- Add an image description for each question in the admin screen. Never reveal the answer in it.
- `prefers-reduced-motion` turns off the coin flight and other animation.

## Tests

```bash
npm test
```

`test/game.test.js` covers the rules. `test/server.test.js` plays a full game over real sockets.
