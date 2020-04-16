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
    if (/^token\s\S+$/i.test(auth)) ctx.session.token = auth.substr(6);
    else ctx.session.token = nanoid(30); // token length set a magic number here :-)
  }
  return next();
});

/**
 * Handles post request to '/' by creating short URL
 *
 * Expected body: { "url": "https://somethingtoshorten...", "expire": optional expiration time in second }
 * Expected result - 201 -> { "shortUrl": "http://localhost...", "token": "..." }
 * @example
 * curl -X POST http://localhost:3000/ -d '{"url": "https://microsoft.com/tada"}' -H "Content-Type: application/json"
 */
router.post("/", async (ctx, next) => {
  const {
    url,
    baseUrl = `http://localhost:${ctx.app.context.port}`,
    expire,
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

  // if we have an expiration on parameters then set it
  if (expire) await redis.expire(linkid, expire);

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
 * All methods bellow requiring valid linkId, so validate it here
 * for all
 */
router.param("linkid", async (linkid, ctx, next) => {
  ctx.assert(linkid.length === LINKID_LEN, 422, `Invalid link id`);
  return next();
});

/**
 * Handles GET request to a link by unfurling and redirecting
 *
 * @example
 * curl http://localhost:3000/afdewb -> 301, Location: https://microsoft.com/tada
 */
router.get("/:linkid", async (ctx) => {
  const { linkid } = ctx.params;

  /** @type {import('ioredis').Redis} */
  const redis = ctx.app.context.redis;

  const [[, accessed], [, fullUrl]] = await redis
    .multi()
    .hincrby(linkid, "accessed", 1)
    .hget(linkid, "url")
    .exec();

  ctx.assert(fullUrl, 404, `There is no ${linkid} on this server`);

  ctx.status = 301; // permanent redirect? or 302?
  ctx.set("X-Accessed", accessed); // for tests
  ctx.redirect(fullUrl);
});

/**
 * All routes below requires Token validation, so, makes it here
 */
router.all("/:linkid", async (ctx, next) => {
  // GET method doesn't need authentication?
  if (ctx.method === "GET") return next();

  const { linkid } = ctx.params;
  /** @type {import('ioredis').Redis} */
  const redis = ctx.app.context.redis;

  const token = await redis.hget(linkid, "token");
  // respond 404 when link not found
  ctx.assert(token, 404, `There is no ${linkid} on this server`);
  ctx.assert(
    token === ctx.session.token,
    401 /* Authentication required */,
    `Invalid link update token`
  );
  return next();
});

/**
 * Deletes link from a server using a token
 *
 * @example
 * curl -X DELETE -H "Authorization: Token <ACCESS_TOKEN>" http://localhost:3000/bukFJHSL
 */
router.delete("/:linkid", async (ctx, next) => {
  const { linkid } = ctx.params;

  /** @type {import('ioredis').Redis} */
  const redis = ctx.app.context.redis;

  // delete it, non-blocking way
  const res = await redis.unlink(linkid);

  ctx.status = 200;
  ctx.type = "json";
  ctx.body = { removed: res };

  return next();
});

/**
 * Update existing short link using a token
 * @example
 * curl -X PATCH -H "Authorization: Token <ACCESS_TOKEN>" http://localhost:3000/bukFJHSL -d '{"url": "https://microsoft.com/new", "expire": 3600}'
 */
router.patch("/:linkid", async (ctx, next) => {
  const { linkid } = ctx.params;
  const { url, expire } = ctx.request.body;

  /** @type {import('ioredis').Redis} */
  const redis = ctx.app.context.redis;

  // updates existing link
  if (url) {
    // validate new url
    new URL(url);
    await redis.hset(linkid, "url", url);
  }
  if (expire) {
    await redis.expire(linkid, expire);
  }
  ctx.status = 200;
  ctx.type = "json";
  ctx.body = { status: "success" };

  return next();
});

app
  .use(bodyparser())
  .use(session())
  .use(router.routes())
  .use(router.allowedMethods());

module.exports = app;
