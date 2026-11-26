
eu
work
dona-vina-bridge
whatsapp-bridge
README.md
Ponte WhatsApp Web para Railway

Serviço Node.js separado para manter uma sessão WhatsApp Web por loja via QR e executar as respostas do robô. É uma integração não oficial e deve ser tratada como protótipo.

Deploy no Railway

1. Conecte o repositório GitHub e escolha a branch main.
2. Defina Root Directory como whatsapp-bridge e Start Command como npm start.
3. Crie um volume persistente montado em /data; a sessão fica em /data/auth.
4. Configure as variáveis:
   - FIREBASE_SERVICE_ACCOUNT: JSON da conta de serviço do projeto Firebase usado pelo site.
   - APP_ORIGINS: origem do site, por exemplo https://dona-vina.vercel.app.
   - MASTER_EMAIL: e-mail master, se for diferente do padrão.
   - AUTH_DIR: opcional; deixe sem definir para usar /data/auth.
5. Faça o deploy. A URL HTTPS do serviço deve ser informada no painel do PDV.

Rotas

- GET /health: verificação do serviço.
- GET /api/stores/:slug/whatsapp/status: status e QR (Firebase ID token obrigatório).
- POST /api/stores/:slug/whatsapp/connect: inicia ou restaura sessão.
- POST /api/stores/:slug/whatsapp/disconnect: desconecta e apaga a sessão da loja.
- POST /api/stores/:slug/whatsapp/send: envio administrativo autenticado.
- POST /api/stores/:slug/orders/:orderId/confirmation: confirmação idempotente de pedido existente, chamada pelo checkout.

O backend valida o token Firebase e compara o e-mail autenticado com ownerEmail do documento stores/{slug}; o usuário master também tem acesso. Nunca publique a chave de serviço no HTML ou no Firestore.

A conexão usa Baileys com sessão persistente em /data/auth. O Railway precisa manter o serviço ativo e o volume anexado. O WhatsApp pode desconectar ou restringir automações não oficiais.

Draggable item app-shell-tab:6 was dropped over droppable area app-shell-tab:1
