import { describe, expect, test } from "bun:test";
import { isStatusQuestion } from "../src/statusQuestions";

describe("isStatusQuestion", () => {
  test("detects short Korean status checks", () => {
    expect(isStatusQuestion("얼마나 남았어?")).toBe(true);
    expect(isStatusQuestion("또 멈췄어 작성중...에서")).toBe(true);
    expect(isStatusQuestion("지금 작업 상태 알려줘")).toBe(true);
  });

  test("detects common English status checks", () => {
    expect(isStatusQuestion("eta?")).toBe(true);
    expect(isStatusQuestion("how long is left?")).toBe(true);
    expect(isStatusQuestion("is it still running?")).toBe(true);
  });

  test("does not treat normal work requests as status checks", () => {
    expect(isStatusQuestion("StatusBar UX를 포토샵처럼 개선해줘")).toBe(false);
    expect(isStatusQuestion("디스코드 봇 응답 문제를 분석하고 수정해줘")).toBe(false);
  });
});
