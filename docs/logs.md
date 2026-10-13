Local log files belong in `backend/logs/` or `frontend/logs/`, never in a project root. Both folders are ignored by Git.

The backend logger already writes daily request and application logs to `backend/logs/YYYY-MM-DD.log`. Vercel runtime logs stay in the Vercel dashboard because its functions do not use persistent local log files.

For saved test or build output in PowerShell, run from the relevant project folder:

```powershell
New-Item -ItemType Directory -Path logs -Force | Out-Null
npm test *> logs/test.log
# In the frontend:
npm run build *> logs/build.log
```

Frontend browser messages remain in the browser console. They are not files generated in the project folder.
