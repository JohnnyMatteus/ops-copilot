# ADR 0010: Trilha de auditoria em S3 com object lock (MinIO no ambiente local)

- **Status:** Aceito
- **Data:** 2026-11-21

## Contexto

A cadeia de hash (ADR 0007) detecta adulteração, mas um arquivo JSONL no disco do contêiner pode ser apagado inteiro, e ele some quando o contêiner é recriado. Para um copiloto que executa ações em produção, a trilha precisa sobreviver a falhas e não pode ser editável nem por quem opera o próprio copiloto.

## Decisão

- Um adaptador `S3ObjectStore` atrás da porta `ObjectStore` e um `ObjectStoreAuditLog` que grava **um objeto por registro** (`audit/000000000042.json`). A sequência tem zeros à esquerda para que a ordem das chaves seja a ordem dos eventos.
- Escrita condicional (`If-None-Match: *`): duas réplicas nunca gravam a mesma sequência. Quem perde recebe `ObjectAlreadyExistsError`, relê o fim da cadeia na próxima escrita e continua.
- Bucket criado com **object lock e versionamento**, com retenção padrão. No ambiente local, o MinIO usa o modo `GOVERNANCE` por 30 dias (`deploy/minio/init.sh`). Na AWS, a recomendação é `COMPLIANCE`.
- O copiloto usa um usuário com política **só de anexar e ler** (`s3:PutObject`, `s3:GetObject` e `s3:ListBucket`), sem `DeleteObject`.
- `AUDIT_SINK=file|s3`. O mesmo código fala com a AWS trocando `S3_ENDPOINT` e as credenciais.

Escolhemos **MinIO** e não LocalStack porque o domínio só precisa de object storage. Os testes de integração (`make test-integration`) provam no MinIO real que sobrescrever e apagar são recusados, inclusive para o administrador sem contornar a governança.

## Consequências

- A trilha fica imutável durante a retenção e sobrevive à recriação do contêiner.
- Cada registro é uma requisição PUT. Isso é aceitável para o volume de decisões (dezenas por dia). Para volumes maiores, o caminho é agrupar registros por lote mantendo o encadeamento.
- Ler a trilha inteira lista o prefixo todo. Para consultas, o próximo passo é indexar (Athena ou exportação periódica).
- Em `GOVERNANCE`, um administrador com permissão explícita de bypass ainda consegue apagar. Isso é proposital no ambiente local (`make clean`).

## Alternativas consideradas

- **LocalStack:** emula muitos serviços AWS que o copiloto não usa. O MinIO é menor e suporta object lock completo.
- **Banco de dados append-only:** precisaria de gatilhos e permissões para impedir `UPDATE`/`DELETE`, e ainda assim um DBA poderia contornar.
- **Ledger dedicado (ex.: QLDB):** garantias fortes, mas é um serviço específico de nuvem e não tem emulação local.
