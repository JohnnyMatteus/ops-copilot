#!/bin/sh
# Cria o bucket da trilha de auditoria com object lock e um usuário que só consegue anexar e ler
# (ADR 0010). Idempotente: pode rodar a cada `make up`.
set -eu

BUCKET="${AUDIT_S3_BUCKET:-ops-copilot-audit}"
RETENTION_DAYS="${AUDIT_RETENTION_DAYS:-30}"

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

# --with-lock liga versionamento e object lock; só é possível na criação do bucket.
mc mb --ignore-existing --with-lock "local/$BUCKET"
# GOVERNANCE em desenvolvimento (um administrador ainda consegue limpar o ambiente);
# em produção o ADR prevê COMPLIANCE, que nem a conta raiz contorna.
mc retention set --default GOVERNANCE "${RETENTION_DAYS}d" "local/$BUCKET"

cat > /tmp/audit-append.json <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"], "Resource": ["arn:aws:s3:::$BUCKET/*"] },
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": ["arn:aws:s3:::$BUCKET"] }
  ]
}
POLICY
mc admin policy create local audit-append /tmp/audit-append.json >/dev/null
mc admin user add local "$AUDIT_WRITER_ACCESS_KEY" "$AUDIT_WRITER_SECRET_KEY" >/dev/null
mc admin policy attach local audit-append --user "$AUDIT_WRITER_ACCESS_KEY" >/dev/null 2>&1 || true

echo "bucket $BUCKET pronto: object lock GOVERNANCE ${RETENTION_DAYS}d, usuário $AUDIT_WRITER_ACCESS_KEY só anexa e lê"
