// Catch-all route for all /api/* subpaths on Vercel.
// Delegates every request to the pre-compiled Express app bundle.
const { app } = require('./_handler.cjs');
module.exports = app;
