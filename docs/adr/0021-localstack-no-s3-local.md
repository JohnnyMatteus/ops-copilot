# ADR 0021: LocalStack no S3 local

- **Status:** Aceito. Substitui a parte do ADR 0010 que escolhia o servidor S3 do ambiente local e rejeitava o LocalStack. O restante do ADR 0010 (um objeto por registro, escrita condicional, object lock, `AUDIT_SINK`) continua valendo.
- **Data:** 2026-11-22

## Contexto

As imagens do servidor S3 e do cliente de linha de comando que o ambiente local usava deixaram de ser publicadas nos registros públicos (conferido por manifesto em 22/11/2026). O `make up` deixou de funcionar em máquina limpa, e a trilha de auditoria (núcleo do produto) depende de um S3 com object lock.

## Decisão

- O S3 local passa a ser o `localstack/localstack:4.4.0` com `SERVICES=s3`, porta publicada só em `127.0.0.1`, cliente com path-style (já era o caso em `S3ObjectStore`).
- `deploy/localstack/init-s3.sh` (bit executável no Git, montado em `/etc/localstack/init/ready.d`) cria o bucket com object lock, versionamento e retenção padrão `GOVERNANCE` de `AUDIT_RETENTION_DAYS` dias, e confere a configuração aplicada. Sem `|| true`.
- O healthcheck consulta `/_localstack/init/ready` e só passa com o estágio concluído, script `SUCCESSFUL` e nenhum `ERROR`; o copiloto depende dele (`service_healthy`).
- As variáveis `MINIO_*` viram `S3_PORT`, `S3_ADMIN_ACCESS_KEY` e `S3_ADMIN_SECRET_KEY`. `make audit` usa `awslocal` dentro do contêiner.
- O CI ganha o job `s3-localstack`, que sobe o S3 pelo compose real e roda os testes de integração de object lock sem afrouxá-los.

## Consequências

- O LocalStack community não persiste entre recriações: a trilha local não é durável. Para demonstração e testes isso basta; para durabilidade vale a AWS.
- Não há enforcement de IAM no community: o usuário "só anexar e ler" do ambiente antigo não existe mais no local. O teste que exige negar `DeleteObject` ao usuário do copiloto depende dessa política e pode falhar no LocalStack; isso é um limite da emulação e não foi mascarado.
- O LocalStack não é prova de conformidade de object lock; apenas o comportamento exercitado pelos testes é verificado.
- A imagem é maior que a do servidor anterior.

## Alternativas consideradas

- **Fixar outra imagem de servidor S3 compatível:** não avaliada com manifesto conferido; mantém o risco de nova retirada.
- **Voltar ao adaptador em memória no local:** perde a prova de object lock e o fluxo real de S3.
