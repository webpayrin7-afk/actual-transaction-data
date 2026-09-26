/**
 * 화면에 보일 단지 이름 — 국토부 실거래 원자료는 이름이 같은 단지를 가르려고 끝에 지번을 괄호로 붙인다
 * ("용산파크타워(24-0)"). 사람에게는 뜻이 없으니 지도·카드에서는 뗀다. "(1단지)"처럼 글자가 섞인 괄호는 둔다.
 * 이름 전체가 괄호 지번뿐이면("(91-511)") 그대로 둔다 (뗄 게 없다).
 */
export function displayAptName(name: string): string {
  const s = name.trim();
  const stripped = s.replace(/\s*\(\d+(?:-\d+)?\)\s*$/, "").trim();
  return stripped || s;
}
