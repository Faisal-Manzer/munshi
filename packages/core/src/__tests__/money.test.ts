import { describe, expect, it } from "vitest";
import { formatPaise, formatPaisePlain, parseRupees } from "@munshi/core";

// Intl output uses a non-breaking space in some ICU builds — normalise it away
const norm = (s: string) => s.replace(/ /g, " ").replace(/\s/g, "");

describe("formatPaise", () => {
  it("always shows exactly two decimals", () => {
    expect(norm(formatPaise(150000))).toBe("₹1,500.00");
    expect(norm(formatPaise(1))).toBe("₹0.01");
    expect(norm(formatPaise(10))).toBe("₹0.10");
  });

  it("uses Indian digit grouping (lakh, crore)", () => {
    expect(norm(formatPaise(12345600))).toBe("₹1,23,456.00");
    expect(norm(formatPaise(1234567800))).toBe("₹1,23,45,678.00");
  });

  it("never renders negative zero", () => {
    expect(norm(formatPaise(0))).toBe("₹0.00");
    expect(norm(formatPaise(-0))).toBe("₹0.00");
  });

  it("formats negatives", () => {
    expect(norm(formatPaise(-150050))).toBe("-₹1,500.50");
  });
});

describe("formatPaisePlain", () => {
  it("formats without the currency symbol", () => {
    expect(norm(formatPaisePlain(12345600))).toBe("1,23,456.00");
    expect(norm(formatPaisePlain(0))).toBe("0.00");
  });
});

describe("parseRupees", () => {
  it("parses plain rupee amounts to paise", () => {
    expect(parseRupees("1500")).toBe(150000);
    expect(parseRupees("17099.50")).toBe(1709950);
    expect(parseRupees("0.01")).toBe(1);
  });

  it("strips ₹, commas and spaces", () => {
    expect(parseRupees("17,099")).toBe(1709900);
    expect(parseRupees("₹ 1,23,456.78")).toBe(12345678);
    expect(parseRupees(" 42 ")).toBe(4200);
  });

  it("rounds to whole paise", () => {
    expect(parseRupees("10.999")).toBe(1100);
    expect(parseRupees("10.001")).toBe(1000);
  });

  it("returns null for empty or invalid input", () => {
    expect(parseRupees("")).toBeNull();
    expect(parseRupees("   ")).toBeNull();
    expect(parseRupees("abc")).toBeNull();
    expect(parseRupees("12abc")).toBeNull();
  });

  it("parses zero and negatives", () => {
    expect(parseRupees("0")).toBe(0);
    expect(parseRupees("-50")).toBe(-5000);
  });

  it("round-trips formatted output", () => {
    for (const paise of [1, 99, 100, 150050, 12345678, 999999999]) {
      expect(parseRupees(formatPaisePlain(paise))).toBe(paise);
    }
  });
});
