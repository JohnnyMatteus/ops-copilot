#!/bin/sh
# Cria o bucket da trilha de auditoria com object lock, versionamento e retenção padrão (ADR 0010 e ADR 0021).
# O LocalStack executa os scripts de /etc/localstack/init/ready.d quando está pronto; o healthcheck do compose
# só fica saudável depois deste script. Idempotente. Variáveis: AUDIT_S3_BUCKET e AUDIT_RETENTION_DAYS.
# Qualquer falha derruba o script e o healthcheck acusa ERROR.
set -eu

BUCKET="${AUDIT_S3_BUCKET:-ops-copilot-audit}"
RETENTION_DAYS="${AUDIT_RETENTION_DAYS:-30}"

# --object-lock-enabled-for-bucket liga object lock (e versionamento); só é possível na criação do bucket.
if ! awslocal s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  awslocal s3api create-bucket --bucket "$BUCKET" --object-lock-enabled-for-bucket
fi
awslocal s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
# GOVERNANCE em desenvolvimento; em produção o ADR prevê COMPLIANCE.
awslocal s3api put-object-lock-configuration --bucket "$BUCKET" \
  --object-lock-configuration "{\"ObjectLockEnabled\":\"Enabled\",\"Rule\":{\"DefaultRetention\":{\"Mode\":\"GOVERNANCE\",\"Days\":${RETENTION_DAYS}}}}"

# Confere o que foi aplicado: se o LocalStack não guardar a configuração, o init falha em vez de fingir.
awslocal s3api get-object-lock-configuration --bucket "$BUCKET" | grep -q '"GOVERNANCE"'
awslocal s3api get-bucket-versioning --bucket "$BUCKET" | grep -q '"Enabled"'

echo "bucket $BUCKET pronto: object lock GOVERNANCE ${RETENTION_DAYS}d e versionamento"
