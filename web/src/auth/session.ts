// Sessão do operador: o bearer fica em sessionStorage (some ao fechar a aba) e é lido a cada
// requisição. Um 401 em qualquer chamada encerra a sessão.
import { ref } from 'vue';

const KEY = 'vigilia.token';

function read(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const token = ref<string | null>(read());

export function setToken(value: string | null): void {
  token.value = value;
  try {
    if (value) sessionStorage.setItem(KEY, value);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Sem storage (aba privada restrita), a sessão vale só enquanto a página estiver aberta.
  }
}
