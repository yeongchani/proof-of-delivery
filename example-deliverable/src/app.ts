import express, { Request, Response } from "express";
import { randomUUID } from "crypto";

interface Item {
  id: string;
  name: string;
}

export const app = express();
app.use(express.json());

const items = new Map<string, Item>();

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

app.post("/items", (req: Request, res: Response) => {
  const name = req.body?.name;
  if (typeof name !== "string" || name.trim() === "") {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const item: Item = { id: randomUUID(), name };
  items.set(item.id, item);
  res.status(201).json(item);
});

app.get("/items/:id", (req: Request, res: Response) => {
  const item = items.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(200).json(item);
});

if (!process.env.VITEST) {
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log(`example-deliverable listening on :${port}`));
}
