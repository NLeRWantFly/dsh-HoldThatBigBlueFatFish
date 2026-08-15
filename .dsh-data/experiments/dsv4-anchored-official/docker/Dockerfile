FROM node:24-bookworm

ARG DSH_COMMIT=47f943859bef60e4160492346772ded9b24f765a
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 python3-venv python3-dev build-essential \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --filter=blob:none https://github.com/deepseek-ai/deepseek-harness.git /opt/dsh \
  && cd /opt/dsh \
  && git checkout "${DSH_COMMIT}" \
  && corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm run build

COPY dsv4-first-action/project2/modeltest/requirements.txt /tmp/evaluator-requirements.txt
COPY dsv4-first-action/project2/modeltest/workspace/project2_task/requirements.txt /tmp/project-requirements.txt
RUN python3 -m venv /opt/project2-venv \
  && /opt/project2-venv/bin/pip install --no-cache-dir -r /tmp/evaluator-requirements.txt -r /tmp/project-requirements.txt \
  && /opt/project2-venv/bin/pip install --no-cache-dir setuptools==80.9.0

ENV PATH="/opt/project2-venv/bin:${PATH}"
WORKDIR /experiments/dsv4-anchored-official
EXPOSE 3091

CMD ["node", "/experiments/dsv4-anchored-official/docker/entrypoint.mjs"]
