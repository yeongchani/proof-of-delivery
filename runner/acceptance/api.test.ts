import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "pod-deliverable";

function observedResponse(res: request.Response) {
  return {
    status: res.status,
    contentType: res.headers["content-type"] ?? "",
    responseBody:
      res.type === "application/json" || res.type.endsWith("+json")
        ? res.body
        : res.text ?? "",
  };
}

describe("example API", () => {
  it("health", async ({ task }) => {
    const res = await request(app).get("/health");
    task.meta.podEvidence = JSON.stringify({
      method: "GET",
      path: "/health",
      ...observedResponse(res),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("create item", async ({ task }) => {
    const res = await request(app).post("/items").send({ name: "widget" });
    task.meta.podEvidence = JSON.stringify({
      method: "POST",
      path: "/items",
      requestBody: { name: "widget" },
      ...observedResponse(res),
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("widget");
    expect(typeof res.body.id).toBe("string");
  });

  it("rejects missing name", async ({ task }) => {
    const res = await request(app).post("/items").send({});
    task.meta.podEvidence = JSON.stringify({
      method: "POST",
      path: "/items",
      requestBody: {},
      ...observedResponse(res),
    });
    expect(res.status).toBe(400);
  });

  it("get item", async ({ task }) => {
    const created = await request(app).post("/items").send({ name: "gadget" });
    const res = await request(app).get(`/items/${created.body.id}`);
    task.meta.podEvidence = JSON.stringify({
      method: "GET",
      path: "/items/" + created.body.id,
      createdItem: created.body,
      ...observedResponse(res),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: created.body.id, name: "gadget" });
  });

  it("404 unknown", async ({ task }) => {
    const res = await request(app).get("/items/does-not-exist");
    task.meta.podEvidence = JSON.stringify({
      method: "GET",
      path: "/items/does-not-exist",
      ...observedResponse(res),
    });
    expect(res.status).toBe(404);
  });
});
