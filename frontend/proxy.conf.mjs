// Dev proxy for /api. The backend port comes from $PORT — in a Claude worktree
// `npm run dev` (scripts/dev.sh) exports it from .env.worktree, which the
// SessionStart hook writes with that worktree's allocated ports. A plain
// `npm start` outside that flow falls back to 7440, the repo-default dev port.
export default {
  '/api': {
    target: `http://localhost:${process.env.PORT || 7440}`,
    secure: false,
    changeOrigin: true,
  },
};
