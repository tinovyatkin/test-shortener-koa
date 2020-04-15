"use strict";

const request = require("supertest");
const Redis = require("ioredis");

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
    app.context.redis.quit();
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
      .expect(200); // non-authorized
    expect(res.body).toMatchObject({ removed: 1 }); // the link should be removed
  });
});
