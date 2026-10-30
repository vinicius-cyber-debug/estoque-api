# Estoque API

API REST de portfólio para cadastrar produtos e registrar entradas e saídas sem permitir saldo negativo. Demonstra transações SQLite, idempotência e testes de integração HTTP.

[![Integração](https://github.com/vinicius-cyber-debug/estoque-api/actions/workflows/ci.yml/badge.svg)](https://github.com/vinicius-cyber-debug/estoque-api/actions/workflows/ci.yml)

**Node.js 24 · SQLite · OpenAPI 3.1 · node:test · sem dependências externas de execução**

## Executar

Requer Node.js **24.13+**. O módulo `node:sqlite` é experimental nessa versão e pode emitir um aviso.

```powershell
git clone https://github.com/vinicius-cyber-debug/estoque-api.git
cd estoque-api
$env:API_KEY = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm start
```

O serviço abre em `http://127.0.0.1:3000`. O banco é criado em `data/estoque.sqlite`. `DATABASE_PATH` e `PORT` podem alterar os valores padrão. A chave é configurada antes de iniciar; não há credencial padrão.

## Experimentar no PowerShell

Em outro terminal, configure a mesma chave usada ao iniciar o serviço:

```powershell
$env:API_KEY = 'cole-a-chave-da-sua-instancia-local'
$headers = @{ Authorization = "Bearer $env:API_KEY" }
$product = Invoke-RestMethod http://127.0.0.1:3000/products -Method Post -Headers $headers -ContentType 'application/json' -Body '{"sku":"BOX-001","name":"Caixa retornável"}'

$headers['Idempotency-Key'] = 'recebimento-001'
Invoke-RestMethod "http://127.0.0.1:3000/products/$($product.id)/movements" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"type":"in","quantity":10,"reason":"Recebimento de demonstração"}'

$headers['Idempotency-Key'] = 'saida-001'
Invoke-RestMethod "http://127.0.0.1:3000/products/$($product.id)/movements" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"type":"out","quantity":3,"reason":"Expedição de demonstração"}'

Invoke-RestMethod "http://127.0.0.1:3000/products/$($product.id)" -Headers $headers
```

O saldo final é **7**. Repetir uma movimentação com a mesma chave e conteúdo devolve a operação original sem alterar o saldo novamente. Reutilizar a chave com outro conteúdo retorna `409`.

## Contrato HTTP

| Método e caminho | Resultado |
| --- | --- |
| `GET /health` | Estado do serviço, sem autenticação. |
| `GET /openapi.json` | Contrato OpenAPI, sem autenticação. |
| `POST /products` | Cadastro com SKU único e saldo inicial zero. |
| `GET /products?limit=20&offset=0` | Produtos paginados. |
| `GET /products/{id}` | Produto e saldo atual. |
| `POST /products/{id}/movements` | Entrada (`in`) ou saída (`out`); exige `Idempotency-Key`. |
| `GET /products/{id}/movements?limit=20&offset=0` | Histórico paginado. |

Confira os corpos e respostas no [openapi.json](openapi.json), que pode ser importado em clientes compatíveis. Os endpoints de dados exigem `Authorization: Bearer <API_KEY>`. Erros usam `{ "error": { "code": "...", "message": "..." } }`.

## Decisões e limites

- **Transação `BEGIN IMMEDIATE`:** saldo e histórico são gravados juntos. Uma falha desfaz a operação inteira.
- **SQLite relacional:** SKU e chave de idempotência únicos, chave estrangeira entre movimento e produto e restrições para saldo e quantidade.
- **Idempotência persistida:** a mesma chave continua protegida após reiniciar o servidor. `balance_after` é o saldo histórico após aquele movimento; consulte o produto para obter o saldo atual.
- **Validação:** quantidades inteiras de 1 a 1 bilhão, saldo máximo de 1 bilhão, paginação de até 100 itens e corpo de até 16 KiB.
- **Escopo:** uma instância local e uma chave de acesso compartilhada. Não há usuários, perfis, auditoria por pessoa ou multiempresa. O histórico registra operações, não identifica um operador individual.
- **Escala:** o acesso SQLite é síncrono e ocupa o processo durante as consultas. O projeto não foi submetido a benchmark de carga nem usado em produção.
- **Acesso:** escuta somente em `127.0.0.1`. Uma implantação pública exigiria definir TLS, autenticação por usuário, gestão de segredos, limites de requisições e operação do banco.

## Validação

```powershell
npm test
npm run test:coverage
```

**21 testes de integração** exercitam HTTP real e bancos SQLite temporários em disco: validação, autenticação, rollback, saldo insuficiente, idempotência, paginação, requisições concorrentes e persistência após reinício. A suíte limpa apenas os diretórios temporários que ela mesma criou.

O cenário de concorrência verifica duas saídas disputando um saldo limitado na mesma instância. Não representa um teste de carga nem valida uma arquitetura distribuída.

## Autoria e contribuição

Projeto de portfólio de [Vinicius Maia](https://www.linkedin.com/in/viniciusmaia001/). A implementação inicial deste projeto foi criada com assistência de IA e validada com a suíte descrita acima.

Para contribuir, abra uma issue com problema e comportamento esperado, implemente em uma branch e envie um PR com os resultados dos testes. Use dados fictícios e mantenha credenciais e bancos fora do versionamento.

[Licença MIT](LICENSE).
