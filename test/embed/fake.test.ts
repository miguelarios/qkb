import { describe, expect, it } from "vitest";
import { FakeProvider } from "../../src/embed/fake.js";

// Ports legacy/python/tests/test_fake_provider.py.
describe("embed/fake", () => {
  it("is deterministic, unit-norm, and dimension-correct", async () => {
    const p = new FakeProvider(8);
    const [a1] = await p.embed(["hello"]);
    const [a2] = await p.embed(["hello"]);
    const [b] = await p.embed(["different"]);
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
    expect(a1).toHaveLength(8);
    const sumSquares = (a1 as number[]).reduce((sum, x) => sum + x * x, 0);
    expect(sumSquares).toBeCloseTo(1.0, 6);
  });

  it("makes embedQuery match embed for the same text", async () => {
    const p = new FakeProvider(8);
    const query = await p.embedQuery("same text");
    const [doc] = await p.embed(["same text"]);
    expect(query).toEqual(doc);
  });

  it("reports modelName as fake-<dim>d and dimension", () => {
    const p = new FakeProvider(8);
    expect(p.modelName).toBe("fake-8d");
    expect(p.dimension).toBe(8);
  });
});
