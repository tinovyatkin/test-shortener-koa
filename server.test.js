"use strict";

const request = require("supertest");
const Redis = require("ioredis-mock");

const app = require("./server");

describe("Link shortener server", () => {
  let server;

  const TEST_LINK = "https://microsoft.com/byaka-buka";
  beforeAll((done) => {
    jest.setTimeout(100000);
    app.context.redis = new Redis();
    server = app.listen(done);
    app.context.port = server.address().port;
  });
  afterAll((done) => {
    app.context.redis.disconnect();
    server.close(done);
  });

  it("shortens new link", async () => {
    const { body } = await request(server)
      .post("/")
      .set("Content-Type", "application/json")
      .send({ url: TEST_LINK })
      .expect("Content-Type", /json/)
      .expect(201);
    expect(body).toMatchObject({
      shortLink: expect.any(String),
      token: expect.any(String),
    });
    // ensure baseUrl is valid
    expect(() => new URL(body.shortLink)).not.toThrow();
  });

  it("expands created link and counts access", async () => {
    const {
      body: { shortLink },
    } = await request(server)
      .post("/")
      .set("Content-Type", "application/json")
      .send({ url: TEST_LINK })
      .expect("Content-Type", /json/)
      .expect(201);

    // should not throw
    const url = new URL(shortLink);

    // get it back
    await request(url.origin)
      .get(url.pathname)
      .expect("Location", TEST_LINK)
      .expect("X-Accessed", "1") // we accessing it for the first time
      .expect(301);

    // make sure counter works
    await request(url.origin)
      .get(url.pathname)
      .expect("Location", TEST_LINK)
      .expect("X-Accessed", "2") // we accessing it for second time
      .expect(301);
  });

  it("returns 404 for unknown, but good formatted link", async () => {
    // make sure there is no such link
    const testLink = "1234567"; // must have the same length
    await app.context.redis.del(testLink);
    await request(server).get(`/${testLink}`).expect(404);
  });

  it("deletes key with valid token", async () => {
    const { body } = await request(server)
      .post("/")
      .set("Content-Type", "application/json")
      .send({
        url: "https://github.com/tinovyatkin",
      })
      .expect("Content-Type", /json/)
      .expect(201);

    expect(body.token).toHaveLength(30);

    // try to remove with invalid token first
    await request(server).delete(`/${body.linkid}`).expect(401); // non-authorized

    // try with token
    const res = await request(server)
      .delete(`/${body.linkid}`)
      .set("Authorization", "Token " + body.token)
      .expect(200); // ok
    expect(res.body).toMatchObject({ removed: 1 }); // the link should be removed
  });

  it("updates key with valid token", async () => {
    const { body } = await request(server)
      .post("/")
      .set("Content-Type", "application/json")
      .send({
        url: "https://github.com/tinovyatkin",
      })
      .expect("Content-Type", /json/)
      .expect(201);

    expect(body.token).toHaveLength(30);

    // try with token
    const res = await request(server)
      .patch(`/${body.linkid}`)
      .set("Authorization", "Token " + body.token)
      .set("Content-Type", "application/json")
      .send({ url: "https://github.com/walletpass", expire: 1 })
      .expect(200);
    expect(res.body).toMatchObject({ status: "success" }); // the link should be removed
    // make sure expire works, wait 2 seconds
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await request(server).get(`/${body.linkid}`).expect(404);
  });

  it("should avoid linkid collisions", async () => {
    // mocking hexist
    const hexistsMock = jest.fn().mockResolvedValueOnce("tada");
    const originalHexists = app.context.redis.hexists;
    app.context.redis.hexists = hexistsMock;
    const {
      body: { shortLink },
    } = await request(server)
      .post("/")
      .set("Content-Type", "application/json")
      .send({ url: TEST_LINK })
      .expect("Content-Type", /json/)
      .expect(201);
    expect(hexistsMock).toHaveBeenCalledTimes(2);
    const url = new URL(shortLink);
    expect(hexistsMock).toHaveBeenLastCalledWith(url.pathname.slice(1), "url");
    // restore to not messup other tests
    app.context.redis.hexists = originalHexists;
  });
});
