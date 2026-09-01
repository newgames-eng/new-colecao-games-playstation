const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders
    }
  });
}

function authOK(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : "";

  return !!env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
}

function requireAdmin(request, env) {
  if (!authOK(request, env)) {
    return json({ error: "Não autorizado" }, 401);
  }
  return null;
}

function getId(path) {
  const match = path.match(/^\/api\/jogos\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function extensionForType(type) {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  return "jpg";
}

async function deleteCoverFiles(env, id) {
  if (!env.BUCKET) return;

  for (const ext of ["jpg", "png", "webp"]) {
    try {
      await env.BUCKET.delete(`capas/jogo-${id}.${ext}`);
    } catch (_) {}
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.DB;

    if (!db) {
      return json({
        error: "Binding D1 'DB' não encontrado."
      }, 500);
    }

    try {

      // =====================================================
      // LOGIN ADMINISTRATIVO
      // =====================================================
      if (
        request.method === "POST" &&
        path === "/api/admin/login"
      ) {
        const body = await request.json().catch(() => ({}));

        const tokenInformado = String(body.token || "").trim();
        const tokenAdmin = String(env.ADMIN_TOKEN || "").trim();

        if (!tokenAdmin) {
          return json({
            ok: false,
            error: "ADMIN_TOKEN não está configurado no Worker."
          }, 500);
        }

        if (!tokenInformado || tokenInformado !== tokenAdmin) {
          return json({
            ok: false,
            error: "Senha administrativa incorreta."
          }, 401);
        }

        return json({
          ok: true,
          mensagem: "Acesso administrativo autorizado."
        });
      }

      // =====================================================
      // TESTE DA API
      // =====================================================
      if (
        request.method === "GET" &&
        path === "/api/health"
      ) {
        const result = await db
          .prepare("SELECT 1 AS ok")
          .first();

        return json({
          ok: result?.ok === 1,
          api: "new-colecao-games-api",
          banco: "new-colecao-games-db",
          r2: !!env.BUCKET
        });
      }

      // =====================================================
      // LISTAR JOGOS
      // =====================================================
      if (
        request.method === "GET" &&
        path === "/api/jogos"
      ) {
        const busca = url.searchParams.get("q") || "";
        const categoria = url.searchParams.get("categoria") || "";

        let sql = `
          SELECT
            j.id,
            j.nome,
            c.nome AS categoria,
            j.plataforma,
            j.ano,
            j.capa_url,
            j.descricao,
            COALESCE(a.nota, 0) AS nota,
            COALESCE(a.jogado, 0) AS jogado,
            COALESCE(a.favorito, 0) AS favorito
          FROM jogos j
          INNER JOIN categorias c
            ON c.id = j.categoria_id
          LEFT JOIN avaliacoes a
            ON a.jogo_id = j.id
          WHERE 1 = 1
        `;

        const params = [];

        if (busca) {
          sql += `
            AND LOWER(j.nome) LIKE LOWER(?)
          `;
          params.push(`%${busca}%`);
        }

        if (categoria) {
          sql += `
            AND c.nome = ?
          `;
          params.push(categoria);
        }

        sql += `
          ORDER BY j.nome COLLATE NOCASE
        `;

        const result = await db
          .prepare(sql)
          .bind(...params)
          .all();

        return json({
          total: result.results.length,
          jogos: result.results
        });
      }

      // =====================================================
      // LISTAR CATEGORIAS
      // =====================================================
      if (
        request.method === "GET" &&
        path === "/api/categorias"
      ) {
        const result = await db
          .prepare(`
            SELECT
              c.id,
              c.nome,
              COUNT(j.id) AS quantidade
            FROM categorias c
            LEFT JOIN jogos j
              ON j.categoria_id = c.id
            GROUP BY c.id, c.nome
            ORDER BY c.nome COLLATE NOCASE
          `)
          .all();

        return json({
          categorias: result.results
        });
      }

      // =====================================================
      // DASHBOARD
      // =====================================================
      if (
        request.method === "GET" &&
        path === "/api/dashboard"
      ) {
        const total = await db
          .prepare(`
            SELECT COUNT(*) AS total
            FROM jogos
          `)
          .first();

        const jogados = await db
          .prepare(`
            SELECT COUNT(*) AS total
            FROM avaliacoes
            WHERE jogado = 1
          `)
          .first();

        const favoritos = await db
          .prepare(`
            SELECT COUNT(*) AS total
            FROM avaliacoes
            WHERE favorito = 1
          `)
          .first();

        const avaliados = await db
          .prepare(`
            SELECT COUNT(*) AS total
            FROM avaliacoes
            WHERE nota > 0
          `)
          .first();

        return json({
          jogos: total?.total || 0,
          jogados: jogados?.total || 0,
          favoritos: favoritos?.total || 0,
          avaliados: avaliados?.total || 0
        });
      }

      // =====================================================
      // SALVAR CAPA NO R2
      // POST /api/capas
      //
      // Campo aceito pelo HTML: "file"
      // =====================================================
      if (
        request.method === "POST" &&
        path === "/api/capas"
      ) {
        const unauthorized = requireAdmin(request, env);
        if (unauthorized) return unauthorized;

        if (!env.BUCKET) {
          return json({
            error: "Binding R2 'BUCKET' não encontrado no Worker."
          }, 500);
        }

        const contentType =
          request.headers.get("content-type") || "";

        if (!contentType.includes("multipart/form-data")) {
          return json({
            error: "Envie a capa usando multipart/form-data."
          }, 400);
        }

        const form = await request.formData();

        const jogoId = Number(
          form.get("jogo_id") ||
          form.get("id") ||
          form.get("jogoId") ||
          form.get("game_id") ||
          0
        );

        const file =
          form.get("file") ||
          form.get("capa") ||
          form.get("imagem");

        if (!jogoId || !Number.isInteger(jogoId)) {
          return json({
            error:
              "ID do jogo não informado. Envie jogo_id junto com a imagem."
          }, 400);
        }

        if (!file || typeof file.arrayBuffer !== "function") {
          return json({
            error: "Nenhuma imagem foi enviada."
          }, 400);
        }

        const jogo = await db
          .prepare(`
            SELECT id, nome
            FROM jogos
            WHERE id = ?
            LIMIT 1
          `)
          .bind(jogoId)
          .first();

        if (!jogo) {
          return json({
            error: "Jogo não encontrado."
          }, 404);
        }

        const tipo = String(file.type || "").toLowerCase();

        const permitidos = [
          "image/jpeg",
          "image/jpg",
          "image/png",
          "image/webp"
        ];

        if (!permitidos.includes(tipo)) {
          return json({
            error:
              "Formato não permitido. Use JPG, PNG ou WEBP."
          }, 400);
        }

        if (file.size > 10 * 1024 * 1024) {
          return json({
            error:
              "A capa não pode ter mais de 10 MB."
          }, 400);
        }

        const ext = extensionForType(tipo);
        const key = `capas/jogo-${jogoId}.${ext}`;

        // Remove formatos antigos antes de gravar o novo.
        await deleteCoverFiles(env, jogoId);

        const buffer = await file.arrayBuffer();

        await env.BUCKET.put(
          key,
          buffer,
          {
            httpMetadata: {
              contentType:
                tipo === "image/jpg"
                  ? "image/jpeg"
                  : tipo,
              cacheControl:
                "public, max-age=31536000"
            }
          }
        );

        // URL ABSOLUTA para funcionar no GitHub Pages.
        const capaUrl =
          `${url.origin}/api/capas/${jogoId}`;

        await db
          .prepare(`
            UPDATE jogos
            SET capa_url = ?
            WHERE id = ?
          `)
          .bind(capaUrl, jogoId)
          .run();

        return json({
          ok: true,
          mensagem: "Capa salva com sucesso.",
          jogo_id: jogoId,
          capa_url: capaUrl,
          url: capaUrl,
          arquivo: key
        });
      }

      // =====================================================
      // EXIBIR CAPA DO R2
      // GET /api/capas/:id
      // =====================================================
      if (
        request.method === "GET" &&
        /^\/api\/capas\/\d+$/.test(path)
      ) {
        if (!env.BUCKET) {
          return json({
            error: "Binding R2 'BUCKET' não encontrado."
          }, 500);
        }

        const jogoId = Number(
          path.match(/^\/api\/capas\/(\d+)$/)[1]
        );

        const arquivos = [
          ["jpg", "image/jpeg"],
          ["png", "image/png"],
          ["webp", "image/webp"]
        ];

        for (const [ext, mime] of arquivos) {
          const object = await env.BUCKET.get(
            `capas/jogo-${jogoId}.${ext}`
          );

          if (object) {
            const headers = new Headers(corsHeaders);
            headers.set("Content-Type", mime);
            headers.set(
              "Cache-Control",
              "public, max-age=31536000"
            );

            if (object.httpMetadata?.contentType) {
              headers.set(
                "Content-Type",
                object.httpMetadata.contentType
              );
            }

            if (object.httpEtag) {
              headers.set("ETag", object.httpEtag);
            }

            return new Response(
              object.body,
              {
                status: 200,
                headers
              }
            );
          }
        }

        return json({
          error: "Capa não encontrada."
        }, 404);
      }

      // =====================================================
      // EXCLUIR CAPA
      // DELETE /api/capas/:id
      // =====================================================
      if (
        request.method === "DELETE" &&
        /^\/api\/capas\/\d+$/.test(path)
      ) {
        const unauthorized = requireAdmin(request, env);
        if (unauthorized) return unauthorized;

        const jogoId = Number(
          path.match(/^\/api\/capas\/(\d+)$/)[1]
        );

        await deleteCoverFiles(env, jogoId);

        await db
          .prepare(`
            UPDATE jogos
            SET capa_url = NULL
            WHERE id = ?
          `)
          .bind(jogoId)
          .run();

        return json({
          ok: true,
          mensagem: "Capa removida com sucesso."
        });
      }

      // =====================================================
      // CADASTRAR JOGO
      // =====================================================
      if (
        request.method === "POST" &&
        path === "/api/jogos"
      ) {
        const unauthorized = requireAdmin(request, env);
        if (unauthorized) return unauthorized;

        const body = await request.json();

        const nome = String(body.nome || "").trim();
        const categoria = String(body.categoria || "").trim();
        const plataforma =
          String(body.plataforma || "PS4").trim();
        const ano =
          body.ano ? Number(body.ano) : null;
        const capa_url =
          String(body.capa_url || "").trim();
        const descricao =
          String(body.descricao || "").trim();

        if (!nome) {
          return json({
            error: "O nome do jogo é obrigatório."
          }, 400);
        }

        if (!categoria) {
          return json({
            error: "A categoria é obrigatória."
          }, 400);
        }

        const cat = await db
          .prepare(`
            SELECT id
            FROM categorias
            WHERE nome = ?
            LIMIT 1
          `)
          .bind(categoria)
          .first();

        if (!cat) {
          return json({
            error: "Categoria não encontrada.",
            categoria
          }, 400);
        }

        const existente = await db
          .prepare(`
            SELECT id
            FROM jogos
            WHERE LOWER(nome) = LOWER(?)
            LIMIT 1
          `)
          .bind(nome)
          .first();

        if (existente) {
          return json({
            error: "Este jogo já está cadastrado.",
            id: existente.id
          }, 409);
        }

        const result = await db
          .prepare(`
            INSERT INTO jogos
              (
                nome,
                categoria_id,
                plataforma,
                ano,
                capa_url,
                descricao
              )
            VALUES
              (?, ?, ?, ?, ?, ?)
          `)
          .bind(
            nome,
            cat.id,
            plataforma,
            ano,
            capa_url,
            descricao
          )
          .run();

        const id = result.meta?.last_row_id;

        if (id) {
          await db
            .prepare(`
              INSERT OR IGNORE INTO avaliacoes
                (
                  jogo_id,
                  nota,
                  jogado,
                  favorito
                )
              VALUES
                (?, 0, 0, 0)
            `)
            .bind(id)
            .run();
        }

        return json({
          ok: true,
          id,
          mensagem: "Jogo cadastrado com sucesso."
        }, 201);
      }

      // =====================================================
      // EDITAR JOGO
      // =====================================================
      if (
        request.method === "PUT" &&
        /^\/api\/jogos\/\d+$/.test(path)
      ) {
        const unauthorized = requireAdmin(request, env);
        if (unauthorized) return unauthorized;

        const id = getId(path);
        const body = await request.json();

        const nome = String(body.nome || "").trim();
        const categoria =
          String(body.categoria || "").trim();
        const plataforma =
          String(body.plataforma || "PS4").trim();
        const ano =
          body.ano ? Number(body.ano) : null;
        const capa_url =
          String(body.capa_url || "").trim();
        const descricao =
          String(body.descricao || "").trim();

        if (!id) {
          return json({
            error: "ID inválido."
          }, 400);
        }

        if (!nome || !categoria) {
          return json({
            error: "Nome e categoria são obrigatórios."
          }, 400);
        }

        const cat = await db
          .prepare(`
            SELECT id
            FROM categorias
            WHERE nome = ?
            LIMIT 1
          `)
          .bind(categoria)
          .first();

        if (!cat) {
          return json({
            error: "Categoria não encontrada."
          }, 400);
        }

        const result = await db
          .prepare(`
            UPDATE jogos
            SET
              nome = ?,
              categoria_id = ?,
              plataforma = ?,
              ano = ?,
              capa_url = ?,
              descricao = ?
            WHERE id = ?
          `)
          .bind(
            nome,
            cat.id,
            plataforma,
            ano,
            capa_url,
            descricao,
            id
          )
          .run();

        if (!result.meta?.changes) {
          return json({
            error: "Jogo não encontrado."
          }, 404);
        }

        return json({
          ok: true,
          mensagem: "Jogo atualizado com sucesso."
        });
      }

      // =====================================================
      // EXCLUIR JOGO
      // =====================================================
      if (
        request.method === "DELETE" &&
        /^\/api\/jogos\/\d+$/.test(path)
      ) {
        const unauthorized = requireAdmin(request, env);
        if (unauthorized) return unauthorized;

        const id = getId(path);

        await deleteCoverFiles(env, id);

        await db
          .prepare(`
            DELETE FROM avaliacoes
            WHERE jogo_id = ?
          `)
          .bind(id)
          .run();

        const result = await db
          .prepare(`
            DELETE FROM jogos
            WHERE id = ?
          `)
          .bind(id)
          .run();

        if (!result.meta?.changes) {
          return json({
            error: "Jogo não encontrado."
          }, 404);
        }

        return json({
          ok: true,
          mensagem: "Jogo excluído com sucesso."
        });
      }

      // =====================================================
      // ALTERAR AVALIAÇÃO
      // =====================================================
      if (
        request.method === "PUT" &&
        /^\/api\/jogos\/\d+\/avaliacao$/.test(path)
      ) {
        const unauthorized = requireAdmin(request, env);
        if (unauthorized) return unauthorized;

        const id = getId(path);
        const body = await request.json();

        const nota = Number(body.nota || 0);
        const jogado = body.jogado ? 1 : 0;
        const favorito = body.favorito ? 1 : 0;

        if (nota < 0 || nota > 5) {
          return json({
            error: "A nota deve estar entre 0 e 5."
          }, 400);
        }

        const jogo = await db
          .prepare(`
            SELECT id
            FROM jogos
            WHERE id = ?
          `)
          .bind(id)
          .first();

        if (!jogo) {
          return json({
            error: "Jogo não encontrado."
          }, 404);
        }

        await db
          .prepare(`
            INSERT OR REPLACE INTO avaliacoes
              (
                jogo_id,
                nota,
                jogado,
                favorito
              )
            VALUES
              (?, ?, ?, ?)
          `)
          .bind(
            id,
            nota,
            jogado,
            favorito
          )
          .run();

        return json({
          ok: true,
          mensagem: "Avaliação atualizada."
        });
      }

      // =====================================================
      // ROTA NÃO ENCONTRADA
      // =====================================================
      return json({
        error: "Rota não encontrada",
        path
      }, 404);

    } catch (error) {
      console.error("ERRO NO WORKER:", error);

      return json({
        error: "Erro no servidor",
        detalhe: error?.message || String(error)
      }, 500);
    }
  }
};
