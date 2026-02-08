/**
 * 마크다운 제거 유틸리티 (카카오톡용)
 * 
 * AI가 마크다운을 쓰지 말라는 지시를 무시하고 사용할 때
 * 후처리로 제거하는 함수
 */

export function stripMarkdown(text) {
  if (!text || typeof text !== "string") return text;

  let result = text;

  // 1. 코드 블록 제거 (```...```)
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    // 코드 내용만 추출 (언어 표시 제거)
    const lines = match.split('\n');
    if (lines.length <= 2) return match.replace(/```/g, '');
    return lines.slice(1, -1).join('\n');
  });

  // 2. 인라인 코드 제거 (`...`)
  result = result.replace(/`([^`]+)`/g, '$1');

  // 3. 볼드 제거 (**...**)
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');

  // 4. 이탤릭 제거 (*...* 또는 _..._)
  result = result.replace(/\*([^*]+)\*/g, '$1');
  result = result.replace(/_([^_]+)_/g, '$1');

  // 5. 헤더 제거 (## ...)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '$1');

  // 6. 마크다운 리스트를 이모지 리스트로 변환
  result = result.replace(/^[\s]*[-*+]\s+(.+)$/gm, '• $1');

  // 7. 숫자 리스트 (1. 2. 3.)
  result = result.replace(/^[\s]*\d+\.\s+(.+)$/gm, (match, content) => {
    // 숫자는 유지하되 마크다운 형식만 제거
    return content;
  });

  // 8. 인용구 제거 (> ...)
  result = result.replace(/^>\s+(.+)$/gm, '$1');

  // 9. 링크 변환 ([text](url) → text: url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // 10. 가로선 제거 (---, ___, ***)
  result = result.replace(/^[\s]*[-_*]{3,}[\s]*$/gm, '');

  // 11. 다중 공백 정리
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

/**
 * 테스트 함수
 */
export function testMarkdownRemoval() {
  const testCases = [
    {
      input: "**볼드 텍스트**와 *이탤릭*",
      expected: "볼드 텍스트와 이탤릭"
    },
    {
      input: "## 제목\n\n내용입니다",
      expected: "제목\n\n내용입니다"
    },
    {
      input: "- 항목 1\n- 항목 2",
      expected: "• 항목 1\n• 항목 2"
    },
    {
      input: "`코드`와 ```\nfunction test() {}\n```",
      expected: "코드와 function test() {}"
    }
  ];

  console.log("마크다운 제거 테스트:");
  testCases.forEach((tc, idx) => {
    const result = stripMarkdown(tc.input);
    const pass = result === tc.expected;
    console.log(`${idx + 1}. ${pass ? '✅' : '❌'}`);
    if (!pass) {
      console.log(`  입력: ${tc.input}`);
      console.log(`  예상: ${tc.expected}`);
      console.log(`  결과: ${result}`);
    }
  });
}
