"use client";

/**
 * The 24 words, shown once. This is the only artefact standing between a
 * forgotten passphrase and permanently unreadable books, so the screen is
 * blunt about that rather than reassuring.
 */
import { useState } from "react";
import { Check, Copy, Printer } from "lucide-react";

export function RecoveryWords({ mnemonic }: { mnemonic: string }) {
  const words = mnemonic.split(" ");
  return (
    <ol className="grid grid-cols-3 gap-x-3 gap-y-1 border border-rule bg-paper px-3 py-2">
      {words.map((w, i) => (
        <li key={i} className="text-xs flex gap-1.5">
          <span className="amount text-ink-faint w-4 text-right">{i + 1}</span>
          <span>{w}</span>
        </li>
      ))}
    </ol>
  );
}

export function RecoveryActions({ mnemonic, email }: { mnemonic: string; email: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(mnemonic);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function print() {
    // a plain window, not the app: nothing to style around, and the sheet
    // that comes out of the printer is the artefact that matters
    const w = window.open("", "_blank", "width=680,height=800");
    if (!w) return;
    const words = mnemonic
      .split(" ")
      .map((word, i) => `<li><span>${i + 1}</span>${word}</li>`)
      .join("");
    w.document.write(`<!doctype html><html><head><title>Munshi recovery kit</title>
<style>
  body { font: 14px/1.5 ui-sans-serif, system-ui; margin: 48px; color: #1c2420; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { color: #5c655f; margin: 0 0 24px; }
  ol { list-style: none; padding: 0; margin: 0 0 24px;
       display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 16px; }
  li { font-family: ui-monospace, monospace; border-bottom: 1px solid #e4e1d8; padding: 4px 0; }
  li span { color: #8b938d; display: inline-block; width: 22px; }
  .warn { border: 1px solid #a63d2f; color: #a63d2f; padding: 12px; font-size: 13px; }
  .meta { color: #8b938d; font-size: 12px; margin-top: 24px; }
</style></head><body>
<h1>Munshi recovery kit</h1>
<p class="sub">${email}</p>
<ol>${words}</ol>
<p class="warn"><strong>Anyone holding these 24 words can read your books.</strong>
Store this sheet where you keep passports and property papers — not in your wallet,
not photographed on your phone. If you lose both your passphrase and this sheet,
your data cannot be recovered by anyone, including us.</p>
<p class="meta">Generated ${new Date().toLocaleDateString("en-IN", {
      day: "2-digit", month: "long", year: "numeric",
    })}</p>
</body></html>`);
    w.document.close();
    w.focus();
    w.print();
  }

  return (
    <div className="flex gap-2">
      <button onClick={copy} type="button"
        className="text-xs border border-rule px-2.5 py-1 flex items-center gap-1 hover:text-ledger">
        {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
      </button>
      <button onClick={print} type="button"
        className="text-xs border border-rule px-2.5 py-1 flex items-center gap-1 hover:text-ledger">
        <Printer size={12} /> Print kit
      </button>
    </div>
  );
}

/**
 * Proof-of-save: two words picked at random must be typed back. A checkbox
 * would let someone click past the one step that cannot be undone later.
 */
export function ConfirmWords({
  mnemonic, onConfirmed,
}: {
  mnemonic: string;
  onConfirmed: () => void;
}) {
  const words = mnemonic.split(" ");
  const [picks] = useState(() => {
    const idxs = new Set<number>();
    while (idxs.size < 2) idxs.add(Math.floor(Math.random() * words.length));
    return [...idxs].sort((a, b) => a - b);
  });
  const [typed, setTyped] = useState<string[]>(["", ""]);
  const ok = picks.every((p, i) => typed[i].trim().toLowerCase() === words[p]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-soft">
        Type these back from your copy — proof it is really saved.
      </p>
      <div className="flex gap-3">
        {picks.map((p, i) => (
          <label key={p} className="flex-1">
            <span className="text-[11px] text-ink-faint">Word {p + 1}</span>
            <input value={typed[i]} autoFocus={i === 0}
              onChange={(e) => setTyped((t) => t.map((v, j) => (j === i ? e.target.value : v)))}
              className="w-full border border-rule px-2 py-1.5 text-sm bg-paper-raised" />
          </label>
        ))}
      </div>
      <button onClick={onConfirmed} disabled={!ok}
        className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90 disabled:opacity-40">
        {ok ? "Done — my kit is safe" : "Type both words"}
      </button>
    </div>
  );
}
