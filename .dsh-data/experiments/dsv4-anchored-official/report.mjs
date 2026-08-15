import { MINIMAL_SYSTEM, PRICING, ROUTE } from './constants.mjs'
import { releaseRank } from './lib.mjs'

function cell(value) {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function fenced(value, language = 'text') {
  const text = String(value || '(empty)')
  const longest = Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1))
  const marker = '`'.repeat(longest)
  return `${marker}${language}\n${text}\n${marker}`
}

function projectPass(standard, anchored) {
  if (!standard || !anchored) return null
  const standardBlockers = new Set(standard.blockers ?? [])
  const newBlockers = (anchored.blockers ?? []).filter(blocker => !standardBlockers.has(blocker))
  return anchored.officialScore >= standard.officialScore
    && anchored.shipDraft >= standard.shipDraft
    && releaseRank(anchored.releaseClassHint) >= releaseRank(standard.releaseClassHint)
    && newBlockers.length === 0
}

export function reportMarkdown({ manifest, scores, projectResults, verification = undefined }) {
  const lines = ['# DeepSeek 官方 API Git-style Anchored Standard 复现实验', '']
  lines.push(`生成时间：${manifest.generatedAt}`, '')
  const probes = scores.filter(score => score.suite === 'probe')
  const projects = projectResults.filter(result => !result.incomplete)
  const standardProbe = probes.find(score => score.condition === 'standard-full')
  const anchoredProbe = probes.find(score => score.condition === 'minimal-anchored')
  const standardProject = projects.find(result => result.condition === 'standard-full')
  const anchoredProject = projects.find(result => result.condition === 'minimal-anchored')
  const behaviorPass = anchoredProbe
    ? anchoredProbe.firstCompliant && anchoredProbe.firstBreadth <= 1 && anchoredProbe.firstToolCallCount <= 2
    : null
  const reasoningPass = anchoredProbe && standardProbe
    ? anchoredProbe.firstReasoningChars < standardProbe.firstReasoningChars
      && anchoredProbe.firstNarrationCharsBeforeAction < standardProbe.firstNarrationCharsBeforeAction
    : null
  const qualityPass = projectPass(standardProject, anchoredProject)
  const recovered = anchoredProject
    ? anchoredProject.outsideBootstrapToolsUsed?.length > 0
    : anchoredProbe?.promotion?.outsideBootstrapToolsUsed?.length > 0

  lines.push('## 结论', '')
  if (scores.length === 0) {
    lines.push('尚未执行在线矩阵；当前报告只记录实现与可复现配置。', '')
  } else if (behaviorPass && reasoningPass && qualityPass && recovered) {
    lines.push('本次描述性复现满足全部预设条件：首步收敛、首轮 reasoning/行动前叙述缩短、后续工具恢复生效，且 Project2 质量不低于同 OS Standard。', '')
  } else if (behaviorPass && qualityPass) {
    lines.push(reasoningPass
      ? '轨迹质量与首步约束均改善，但后续恢复能力判据未全部满足。'
      : '轨迹质量改善，过度思考未充分纠正。', '')
  } else if (behaviorPass) {
    lines.push('schema containment 有效，质量增益未确认。', '')
  } else {
    lines.push('本次样本没有满足 Anchored 首步通过条件；保留完整轨迹供定位。', '')
  }
  lines.push('每条件每 OS 只有一次长测，结论仅是描述性复现，不代表统计显著。', '')

  lines.push('## 环境与输入固定', '')
  lines.push(`- 平台：\`${manifest.platform}\`；DSH Host：\`${manifest.hostBaseUrl}\``)
  lines.push(`- 模型路由：\`${ROUTE.provider}/${ROUTE.model}\`；reasoningEffort=\`${ROUTE.reasoningEffort}\``)
  lines.push(`- API 产品：\`deepseek-api\`；baseURL：\`${manifest.officialBaseUrl}\``)
  lines.push(`- DSH commit：\`${manifest.dsh?.commit ?? 'unknown'}\`；dirty：\`${manifest.dsh?.dirty ?? 'unknown'}\``)
  lines.push(`- Node：\`${manifest.versions?.node ?? ''}\`；pnpm：\`${manifest.versions?.pnpm ?? ''}\`；Python：\`${manifest.versions?.python ?? ''}\``)
  lines.push(`- Minimal system：\`${MINIMAL_SYSTEM}\`（${MINIMAL_SYSTEM.length} 字符，SHA-256 \`${manifest.hashes?.minimalSystem}\`）`)
  lines.push(`- Project2 commit：\`${manifest.project2?.commit ?? ''}\`；题面 SHA-256：\`${manifest.project2?.candidatePromptSha256 ?? ''}\``)
  lines.push(`- handoff 初始哈希：${cell([...new Set((manifest.samples ?? []).map(sample => sample.handoffSha256).filter(Boolean))]) || '尚无样本'}`)
  lines.push(`- 价格快照：${PRICING.capturedOn}，USD/百万 token：cache hit ${PRICING.cacheHitInput}、cache miss ${PRICING.cacheMissInput}、output ${PRICING.output}；[官方价格页](${PRICING.source})。`)
  lines.push('')

  lines.push('## 五条件短探针', '')
  if (probes.length === 0) {
    lines.push('尚无在线短探针。', '')
  } else {
    lines.push('| 条件 | 首请求 system 字符 | 首请求工具 | 首步调用 | 广度 | reasoning 字符 | 行动前叙述 | TTFT ms | 响应 ms | 请求数 | 缓存未命中 | 缓存命中 | 输出 | 估算 USD |')
    lines.push('|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const row of probes) {
      lines.push(`| ${row.condition} | ${row.firstSystemChars} | ${cell(row.firstToolNames)} | ${row.firstToolCallCount} | ${row.firstBreadth} | ${row.firstReasoningChars} | ${row.firstNarrationCharsBeforeAction} | ${cell(row.ttftMs)} | ${cell(row.responseMs)} | ${row.requestCount} | ${cell(row.usage.inputTokens)} | ${cell(row.usage.cacheReadTokens)} | ${cell(row.usage.outputTokens)} | ${row.cost.estimated} |`)
    }
    lines.push('', '### 消融差值（右侧减左侧）', '')
    const pairs = [
      ['standard-full', 'minimal-full', 'system/context'],
      ['standard-full', 'standard-anchored', '首轮 schema'],
      ['standard-anchored', 'minimal-anchored', 'system/context（相同晋级）'],
      ['minimal-fixed', 'minimal-anchored', '后续恢复'],
      ['minimal-full', 'minimal-anchored', '首轮 schema（相同 Minimal）'],
    ]
    lines.push('| 左侧 | 右侧 | 隔离变量 | Δreasoning | Δ行动前叙述 | Δ首步调用 | Δ广度 | Δ请求数 |')
    lines.push('|---|---|---|---:|---:|---:|---:|---:|')
    for (const [leftName, rightName, variable] of pairs) {
      const left = probes.find(row => row.condition === leftName)
      const right = probes.find(row => row.condition === rightName)
      if (!left || !right) continue
      lines.push(`| ${leftName} | ${rightName} | ${variable} | ${right.firstReasoningChars - left.firstReasoningChars} | ${right.firstNarrationCharsBeforeAction - left.firstNarrationCharsBeforeAction} | ${right.firstToolCallCount - left.firstToolCallCount} | ${right.firstBreadth - left.firstBreadth} | ${right.requestCount - left.requestCount} |`)
    }
    lines.push('')
  }

  lines.push('## Project2 V4.1b 官方评分', '')
  if (projects.length === 0) {
    lines.push('尚无完整 Project2 官方评分产物。', '')
  } else {
    lines.push('| 条件 | Ability | Ship | Release | F9 mode | F11 | Blockers | 请求数 | input | cache | output | reasoning | 估算 USD | 耗时 s | 后续新增工具 |')
    lines.push('|---|---:|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|')
    for (const row of projects) {
      lines.push(`| ${row.condition} | ${cell(row.officialScore)} | ${cell(row.shipDraft)} | ${cell(row.releaseClassHint)} | ${cell(row.f9Mode)} | ${cell(row.f11Status)} | ${cell(row.blockers)} | ${cell(row.providerRequests)} | ${cell(row.tokenUsage.inputTokens)} | ${cell(row.tokenUsage.cacheReadTokens)} | ${cell(row.tokenUsage.outputTokens)} | ${cell(row.tokenUsage.reasoningTokens)} | ${cell(row.estimatedCostUsd)} | ${cell(row.durationSec)} | ${cell(row.outsideBootstrapToolsUsed)} |`)
    }
    lines.push('', '### Family draft', '')
    lines.push('| 条件 | F1 | F2 | F3 | F4 | F5 | F6 | F7 | F8 | F9 | F10 | F11 | F12 |')
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const row of projects) {
      const family = row.familyDraft ?? {}
      lines.push(`| ${row.condition} | ${cell(family.F1)} | ${cell(family.F2)} | ${cell(family.F3)} | ${cell(family.F4)} | ${cell(family.F5)} | ${cell(family.F6)} | ${cell(family.F7)} | ${cell(family.F8)} | ${cell(family.F9)} | ${cell(family.F10)} | ${cell(family.F11)} | ${cell(family.F12)} |`)
    }
    lines.push('', '### Dimensions', '')
    lines.push('| 条件 | final_code | security | migration | esp_deploy | process_truth |')
    lines.push('|---|---:|---:|---:|---:|---:|')
    for (const row of projects) {
      const dimensions = row.dimensions ?? {}
      lines.push(`| ${row.condition} | ${cell(dimensions.final_code)} | ${cell(dimensions.security)} | ${cell(dimensions.migration)} | ${cell(dimensions.esp_deploy)} | ${cell(dimensions.process_truth)} |`)
    }
    lines.push('')
  }

  lines.push('## 晋级与结构验证', '')
  if (verification) {
    lines.push(`- 总体：${verification.ok ? '通过' : '未通过'}；错误 ${verification.errors.length}；警告 ${verification.warnings.length}。`)
    for (const error of verification.errors) lines.push(`- ERROR: ${error}`)
    for (const warning of verification.warnings) lines.push(`- WARNING: ${warning}`)
  } else {
    lines.push('- 请运行 `node verify.mjs --run <run-directory>` 生成结构验证结果。')
  }
  for (const row of scores.filter(score => score.condition.endsWith('-anchored'))) {
    lines.push(`- ${row.id}: durable tool/call=${row.promotion.durableToolCallSeen}; following-request promotion=${row.promotion.promotedOnFollowingRequest}; promoted tools=${cell(row.promotion.promotedToolCount)}; 后续目录外工具=${cell(row.promotion.outsideBootstrapToolsUsed) || '无'}。`)
  }
  lines.push('')

  lines.push('## 前三次 assistant 调用轨迹', '')
  for (const row of scores) {
    lines.push(`### ${row.id}`, '')
    lines.push(`- session：\`${row.sessionId}\``)
    lines.push(`- prompt SHA-256：\`${row.promptSha256}\``)
    lines.push(`- first request-header SHA-256：\`${row.firstHeaderSha256}\``)
    lines.push(`- first system SHA-256：\`${row.firstSystemSha256}\``)
    lines.push(`- first tool schema SHA-256：\`${row.firstToolSchemaSha256}\``)
    lines.push(`- usage：\`${JSON.stringify(row.usage)}\``)
    lines.push('', '**完整用户问题**', '', fenced(row.prompt), '')
    for (const message of row.firstThree) {
      lines.push(`#### Assistant request ${message.index}`, '')
      lines.push(`- turn/step：\`${message.turn}/${message.step}\`；header SHA-256：\`${message.headerSha256}\`；tools：${cell(message.toolNames)}`)
      lines.push('', '**Reasoning blocks 原文**', '', fenced(message.reasoning), '')
      lines.push('**Text blocks 原文**', '', fenced(message.text), '')
      lines.push('**Tool-call JSON**', '', fenced(JSON.stringify(message.toolCalls, null, 2), 'json'), '')
    }
  }

  lines.push('## 解释边界', '')
  lines.push('- 主 Anchored 条件没有工具 guard；shell 内部仍能枚举或编排。首轮风险的降低来自模型可见 schema，不是运行时拒绝。')
  lines.push('- 晋级只读持久 session event 中的 `tool/call`；不读取 assistant 文本/reasoning，不依赖 `tool/result` 或易失内存。')
  lines.push('- Minimal 的 persona 与 runtime 在晋级后保持不变，只有下一次模型请求的工具目录恢复为 Standard。')
  lines.push('- 官方 API 不提供确定性 seed。稳定复现定义为相同冻结输入与结构约束再次满足判据；`replay` 只保证已保存事件生成逐字节一致的 `scores.json`。')
  return `${lines.join('\n')}\n`
}
