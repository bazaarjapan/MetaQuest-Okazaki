for (const button of document.querySelectorAll('#print-manual,[data-print-manual]')) {
  button.addEventListener('click', () => window.print());
}
document.querySelector('#copy-class-url')?.addEventListener('click', async () => {
  const status = document.querySelector('#copy-status');
  try {
    await navigator.clipboard.writeText('https://metaquest001.gigach.net/');
    status.textContent = '参加URLをコピーしました。ID・パスワードは本人にだけ渡してください。';
  } catch {
    status.textContent = 'コピーできませんでした。上のURLを選択してコピーしてください。';
  }
});
// Include troubleshooting in print/PDF even when its disclosures were closed.
// Restore their previous state after printing, without persisting preferences.
let printState;
window.addEventListener('beforeprint', () => {
  if (printState) return;
  printState = [...document.querySelectorAll('details')].map(node => [node, node.open]);
  for (const [node] of printState) node.open = true;
});
window.addEventListener('afterprint', () => {
  for (const [node, open] of printState ?? []) node.open = open;
  printState = undefined;
});
