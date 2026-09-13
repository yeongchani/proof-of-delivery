import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "pod-deliverable";

describe("example API", () => {
  it("health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("create item", async () => {
    const res = await request(app).post("/items").send({ name: "widget" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("widget");
    expect(typeof res.body.id).toBe("string");
  });

  it("rejects missing name", async () => {
    const res = await request(app).post("/items").send({});
    expect(res.status).toBe(400);
  });

  it("get item", async () => {
    const created = await request(app).post("/items").send({ name: "gadget" });
    const res = await request(app).get(`/items/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: created.body.id, name: "gadget" });
  });

  it("404 unknown", async () => {
    const res = await request(app).get("/items/does-not-exist");
    expect(res.status).toBe(404);
  });
});
