"use strict";

const Koa = require("koa");
const bodyparser = require("koa-bodyparser");
const Router = require("koa-router");
const session = require("koa-session2");
const { nanoid } = require("nanoid");

const app = new Koa();
const router = new Router();

const LINKID_LEN = 7;

/**
 * Saving authentication token for all requests from header into session
 */
router.all("*", async (ctx, next) => {
  // check session token in Authentication header and create one
  // if it doesn't exists
  if (!ctx.session.token) {
    // check if we have a header
    const auth = ctx.get("Authorization");
    if (/^token\s\w+$/i.test(auth)) ctx.session.token = auth.substr(6);
    else ctx.session.token = nanoid(30); // token length set a magic number here :-)
  }
  return next();
});

/**
 * Handles post request to '/' by creating short URL
 *
 * Expected body: { "url": "https://somethingtoshorten..." }
 * Expected result - 201 -> { "shortUrl": "http://localhost...", "token": "..." }
 * @example
 * curl -X POST http://localhost:3000/ -d '{"url": "https://microsoft.com/tada"}' -H "Content-Type: application/json"
 */
router.post("/", async (ctx, next) => {
  const {
    url,
    baseUrl = `http://localhost:${ctx.app.context.port}`,
  } = ctx.request.body;
  // verify that url is in correct format - URL constructor throws if it doesn't
  new URL(url);

  // get or create user
  const { token } = ctx.session;

  /** @type {import('ioredis').Redis} */
  const redis = ctx.app.context.redis;

  // create new nano id
  let linkid;
  let attempts = 0;
  do {
    linkid = nanoid(LINKID_LEN); // we use just 7 symbols for ID, so, collision is probably here
    const link = await redis.hexists(linkid, "url");
    if (link) {
      linkid = undefined;
      attempts++;
    }
  } while (!linkid && attempts < 10);

  // set it to redis
  const res = await redis.hmset(linkid, {
    url,
    baseUrl,
    accessed: 0,
    createdAt: new Date(), // just in case
    token,
  });
  ctx.assert(res === "OK", 501, `Failed to set key ${linkid} to Redis`);

  console.info("Created short link %s for link %s", linkid, url);
  ctx.status = 201; // created
  ctx.type = "json";
  ctx.body = {
    url,
    shortLink: new URL(linkid, baseUrl),
    linkid,
    token,
  };

  return next();
});

/**
 * Handles GET request to a link by unfurling and redirecting
 *
 * @example
 * curl http://localhost:3000/afdewb -> 301, Location: https://microsoft.com/tada
 */
router.get("/:linkid", async (ctx, next) => {
  // basic validate
  const { linkid } = ctx.params;
  ctx.assert(linkid.length === LINKID_LEN, 422, `Invalid link id`);

  /** @type {import('ioredis').Redis} */
  const redis = ctx.app.context.redis;

  const [[, accessed], [, fullUrl]] = await redis
    .multi()
    .hincrby(linkid, "accessed", 1)
    .hget(linkid, "url")
    .exec();

  ctx.status = 301; // permanent redirect? or 302?
  ctx.set("X-Accessed", accessed); // for tests
  ctx.redirect(fullUrl);

  return next();
});

/**
 * Deletes link from a server using a token
 *
 * @example
 * curl -X DELETE -H "Authorization: Token <ACCESS_TOKEN>" http://localhost:3000/bukFJHSL
 */
router.delete("/:linkid", async (ctx, next) => {
  // basic validate
  const { linkid } = ctx.params;
  ctx.assert(linkid.length === LINKID_LEN, 422, `Invalid link id`);

  /** @type {import('ioredis').Redis} */
  const redis = ctx.app.context.redis;

  const token = await redis.hget(linkid, "token");
  ctx.assert(
    token === ctx.session.token,
    401 /* Authentication required */,
    "Invalid link delete token"
  );

  // delete it, non-blocking way
  const res = await redis.unlink(linkid);

  ctx.status = 200;
  ctx.type = "json";
  ctx.body = { removed: res };

  return next();
});

app
  .use(bodyparser())
  .use(session())
  .use(router.routes())
  .use(router.allowedMethods());

module.exports = app;
