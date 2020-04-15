"use strict";

const Redis = require("ioredis");
const app = require("./server");

async function start(done) {
  app.context.redis = new Redis(
    process.env.REDIS_URL || "redis://localhost:6379"
  );
  const port = process.env.PORT || "3000";
  app.context.port = port;
  return app.listen(port, () => {
    console.info("Server is listening on port %s", port);
    if (typeof done === "function") done();
  });
}

// export for tests
module.exports = start;
// start server if running directly
if (!module.parent) start();
