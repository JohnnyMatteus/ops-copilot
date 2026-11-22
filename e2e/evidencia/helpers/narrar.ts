import type { APIResponse, Page } from '@playwright/test';

export interface Chamada {
  readonly metodo: string;
  readonly url: string;
  readonly status: number;
  readonly corpo: unknown;
  /** O corpo exibido é um recorte da resposta real (campos selecionados). */
  readonly recorte?: boolean;
}

export interface Detalhe {
  readonly descricao: string;
  readonly chamada?: Chamada;
  /** Saída real de um comando (redis-cli, awslocal, docker compose). */
  readonly comando?: { readonly linha: string; readonly saida: string };
  readonly pausaMs?: number;
}

const escapar = (texto: string) =>
  texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const formatar = (corpo: unknown) => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo, null, 2));

/** Cartão de narração em tela cheia; o vídeo fica parado nele por ~2,8 s. */
export async function narrar(page: Page, titulo: string, detalhe: Detalhe): Promise<void> {
  const { chamada, comando } = detalhe;
  const blocoChamada = chamada
    ? `<div class="req"><span class="m">${escapar(chamada.metodo)}</span> ${escapar(chamada.url)}
         <span class="s s${String(chamada.status)[0]}">${chamada.status}</span>${chamada.recorte ? '<span class="tag">recorte da resposta</span>' : ''}</div>
       <pre>${escapar(formatar(chamada.corpo))}</pre>`
    : '';
  const blocoComando = comando
    ? `<div class="req"><span class="m">$</span> ${escapar(comando.linha)}</div><pre>${escapar(comando.saida.trim())}</pre>`
    : '';
  await page.setContent(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
    body{margin:0;height:100vh;background:#0f172a;color:#e2e8f0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;
      display:flex;flex-direction:column;padding:28px 40px;box-sizing:border-box;gap:12px}
    h1{margin:0;font-size:30px;color:#f8fafc}
    p{margin:0;font-size:18px;line-height:1.45;color:#cbd5e1;white-space:pre-line}
    .req{font-family:ui-monospace,Menlo,monospace;font-size:15px;color:#e2e8f0;background:#1e293b;padding:8px 12px;border-radius:6px}
    .m{color:#38bdf8;font-weight:700;margin-right:6px}
    .s{margin-left:10px;padding:2px 8px;border-radius:4px;font-weight:700}
    .s2{background:#166534}.s4{background:#9a3412}.s5{background:#991b1b}
    .tag{margin-left:10px;font-size:12px;color:#fbbf24}
    pre{margin:0;flex:1;overflow:hidden;font-size:12.5px;line-height:1.35;background:#020617;color:#a5f3fc;padding:12px 14px;border-radius:6px;
      white-space:pre-wrap;word-break:break-all}
  </style></head><body><h1>${escapar(titulo)}</h1><p>${escapar(detalhe.descricao)}</p>${blocoChamada}${blocoComando}</body></html>`);
  await page.waitForTimeout(detalhe.pausaMs ?? 2_800);
}

/** Lê o corpo da resposta real como JSON (ou texto) para exibir no cartão. */
export async function corpoDe(resposta: APIResponse): Promise<unknown> {
  const texto = await resposta.text();
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}
