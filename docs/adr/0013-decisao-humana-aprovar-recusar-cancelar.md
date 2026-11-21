# ADR 0013: Decisão humana: aprovar, recusar com motivo e cancelar

- **Status:** Aceito
- **Data:** 2026-11-21

## Contexto

O gate manda para aprovação o que não pode rodar sozinho (ADR 0002). Faltava fechar o ciclo: registrar o motivo de uma recusa, permitir abandonar um incidente que deixou de fazer sentido e mostrar no incidente o que a pessoa decidiu.

## Decisão

- **Aprovar** (`POST /approvals/:id {"decision":"approve","reason"?}`): o gate reavalia (`authorizeApproved`), a ação executa em dry-run e a trilha ganha `approval_granted` e `action_executed` assinados pelo operador.
- **Recusar** (`{"decision":"reject","reason":"..."}`): o motivo é **obrigatório** (3 a 500 caracteres; sem ele, 400 e o pedido continua na fila). A trilha registra `approval_rejected` com `reason` e `via`.
- **Cancelar** (`POST /incidents/:id/cancel {"reason"}`): só vale para incidente `awaiting_approval` ainda sem decisão. O pedido sai da fila (`take`, atômico: se outra pessoa decidiu antes, 409), a trilha registra `incident_cancelled` e o ciclo termina. Incidentes já encerrados pelo gate (`blocked`, `suggested`, `auto_executed`) não são cancelados: não há o que abortar.
- O desfecho fica em `IncidentReport.resolution` (`approved | rejected | cancelled | blocked`, quem, motivo, quando, execução), para o painel mostrar a decisão sem reler a trilha. A trilha continua a fonte da verdade.
- Aprovação expirada não executa (410). O prazo aparece no painel como contagem regressiva.
- `EXECUTION_MODE=dry-run` continua o padrão; aprovar descreve a ação, não a executa de verdade (ADR 0006).

## Consequências

- Toda decisão humana tem autor e motivo auditáveis.
- `resolution` é uma projeção gravada depois da trilha; se a gravação falhar, a trilha continua correta e o painel mostra o incidente como pendente até a próxima leitura da trilha.
- Cancelar não interrompe uma investigação em andamento (a investigação é curta e termina sozinha).
