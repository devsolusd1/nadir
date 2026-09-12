# pons-bond

Bond + stake engine acoplado a um token lançado na **Pons v2** (Robinhood Chain), com as taxas de criador divididas
em código: uma parte fixa pra tesouraria, o resto trabalhando no protocolo (rendimento em ETH pros stakers e
buyback que paga os bonds).

Contratos (`contracts/`):

| Contrato | Papel |
|---|---|
| `FeeSplitter` | É o `creatorFeeRecipient` do token na Pons. `harvest()` (qualquer um chama) saca do FeeEscrow da Pons e reparte `treasuryBps` pra tesouraria e o resto pro `BondEngine`. Sem dono, sem saque, shares imutáveis. |
| `BondEngine` | Oráculo TWAP do pool Uniswap v4, bonds com bônus por desconto (fila FIFO, vesting), staking com recompensa em ETH, buyback por época via PoolManager v4, pausa só de entradas (máx. 7 dias), parâmetros com timelock de 48 h. |

## Ordem de deploy (mainnet 4663)

Tudo é lido do `.env` (copie de `.env.example`). Preencha `DEPLOYER_PK`, `TREASURY` e `RH_RPC` antes do passo 1;
`TOKEN`, `SPLITTER` e `GUARDIAN` antes do passo 3; `ENGINE` antes do passo 4.

1. **Antes do launch** — FeeSplitter (grava tesouraria + 60% de forma imutável):
   ```bash
   npx hardhat run scripts/1-deploy-splitter.js --network robinhood
   ```
2. **Launch na Pons** (site da Pons ou `launchAndBuy` no router `0xe33E…2948`):
   `creatorFeeRecipient = <FeeSplitter do passo 1>`, `creatorTaxBps` à sua escolha (teto 1000 = 10%; 200–300 é o sustentável), `pairToken = ETH`.
   A taxa de criador **não muda depois**; o recipient muda só com timelock de 3 dias.
3. **Depois do launch** — BondEngine com o endereço do token, e wiring do splitter (uma vez só):
   ```bash
   npx hardhat run scripts/2-deploy-engine.js --network robinhood
   ```
4. **Depois da graduação** (pool v4 vivo) — `start()` e keeper de hora em hora:
   ```bash
   npx hardhat run scripts/3-start-and-poke.js --network robinhood
   ```
   (`LOOP=1` no `.env` pra ele ficar rodando.) Adicione `VERIFY=1` no `.env` pra verificar os contratos no Blockscout logo após o deploy.
5. Preencher `site/config.js` (endereços + `treasuryBps`) e publicar a pasta `site/` (estático): `index.html` = terminal (arte ASCII gerada em `ascii.js`, botões ASCII, barra de status, prompt, dashboard, bond, stake, manutenção), `docs.html` = NFO/documentação em inglês no mesmo tema. Fonte: stack monoespaçada do sistema com box-drawing (Cascadia/Consolas/Menlo).

Endereços da Pons/Uniswap usados estão em `scripts/addresses.js` (PoolKey confirmada contra o pool do REVENANT:
currency0 = ETH, currency1 = token, fee 0, tickSpacing 200, hook = MemeHook).

## RPC do site

`site/config.js` tem `rpcs` (lista em ordem de preferência: Alchemy → oficial → publicnode) e `multicall` (Multicall3 em `0xcA11bde05977b3631167028862bE2a173976CA11`). `site/rpc.js` manda cada requisição pro primeiro RPC que responde e pula pro próximo em erro de rede ou de limite; todas as leituras do dashboard vão num único `aggregate3`. A chave da Alchemy é de leitura e fica pública no frontend por natureza: restrinja ela ao domínio do site no painel da Alchemy. Os scripts e o keeper leem `RH_RPC` do `.env`.

## Parâmetros padrão (`scripts/addresses.js`)

| Parâmetro | Valor | Significado |
|---|---|---|
| epochLength | 3600 s | 1 amostra de preço por hora |
| window | 24 | alvo = média das últimas 24 h |
| minSamples | 6 | bonds abrem 6 h depois do `start()` |
| maxBonusBps / bandBps | 5000 / 5000 | +50% de bônus quando o preço está 50% abaixo do alvo, linear até lá |
| entryBurnBps | 100 | 1% da entrada queimado |
| vestEpochs | 24 | bond vence em 24 h |
| penaltyBps | 2000 | sair antes devolve principal menos 20% |
| releaseBps | 1000 | 10% da reserva de ETH vira buyback por época |
| stakingShareBps | 5000 | metade do ETH que entra vai pros stakers, metade pra reserva |

## Segurança (o que o guardian pode e não pode)

- Pode: `pause(duration ≤ 7 dias)` bloqueando **só** `bond` e `stake`; `proposeParams` que só executa 48 h depois.
- Não pode: mover token ou ETH de usuário, mudar endereços, mudar o pool, pausar `unstake`, `exit`, `settle`, `claimRewards`, `poke`.
- Recomendação: guardian = Safe 2-de-3; tesouraria = a mesma Safe.

## Testes

```bash
npx hardhat test                                            # unitários (mocks)
FORK=1 RH_RPC=https://rpc.ordofi.network npx hardhat test test/fork.test.js   # buyback real no pool do REVENANT
```

## Demo local do site

```bash
npx hardhat node
npx hardhat run scripts/dev-local.js --network localhost    # gera site/config.local.js
python -m http.server 4180 --directory site                 # abre http://localhost:4180
```
