import { Coggers, express, renderEngine } from "coggers";
import coggersSession from "coggers-session";
import { renderFile } from "poggies";
import sirv from "sirv";
import { fileURLToPath } from "url";
import { keyRegex, partRegex } from "../generator/generator.js";
import { login, twitter } from "../tweeting/twitter.js";
import { db } from "./db.js";
const coggers = new Coggers(
  {
    $: [
      coggersSession({
        name: "eztwitbot-session",
        cookie: {
          httpOnly: true,
          sameSite: "Lax",
          maxAge: 604800,
          path: "/",
        },
        password: JSON.parse(process.env.SESSIONPASSWORDS),
      }),
      express(
        sirv(fileURLToPath(new URL("../generator", import.meta.url))),
        sirv(fileURLToPath(new URL("public", import.meta.url)))
      ),
      renderEngine(renderFile, new URL("views", import.meta.url), "pog"),
    ],
    $get(_, res) {
      res.render("index");
    },
    redirecttwt: {
      async $get(req, res) {
        if (req.headers.host == null) return res.sendStatus(400);
        const host = req.headers.host;
        const s = host === "localhost" ? "" : "s";
        try {
          const result = await twitter.generateAuthLink(
            `http${s}://${host}/finishauth`,
            {
              authAccessType: "write",
              linkMode: "authorize",
            }
          );
          if (result.oauth_callback_confirmed !== "true") res.sendStatus(500);
          req.session.oauthToken = result.oauth_token;
          req.session.oauthTokenSecret = result.oauth_token_secret;
          res.saveSession();
          res.redirect(result.url + "&force_login=true");
        } catch (err) {
          console.error(err);
          res.status(500).send("uh oh.");
        }
      },
    },
    finishauth: {
      async $get(req, res) {
        if (
          req.session.oauthToken == null ||
          req.session.oauthTokenSecret == null
        )
          return res.sendStatus(400);
        try {
          const result = await login(
            req.session.oauthToken,
            req.session.oauthTokenSecret,
            req.query.oauth_verifier
          );
          try {
            await db.addBot(
              result.userId,
              result.accessToken,
              result.accessSecret
            );
            delete req.session.oauthToken;
            delete req.session.oauthTokenSecret;
            req.session.botid = result.userId;
            res.saveSession();
            res.redirect("/editor");
          } catch (err) {
            console.error(err);
            res
              .status(500)
              .type("html")
              .send(
                `<html style="background: url('/databasebroke.jpg') no-repeat center center fixed; background-size: 100vmin 100vmin; color: red;">Database broke</html>`
              );
          }
        } catch (err) {
          console.error(err);
          res.redirect("/");
        }
      },
    },
    editor: {
      async $get(req, res) {
        const botid = req.session.botid;
        if (botid == null) return res.redirect("/redirecttwt");
        else if (!/^[0-9]+$/.test(botid))
          return res.status(400).send("Invalid ID");
        try {
          const grammar = await db.getGrammar(botid);
          res.render("editor", {
            botid,
            grammar: encodeURI(JSON.stringify(grammar)),
          });
        } catch (err) {
          if (err === 404)
            res
              .status(404)
              .send("This twitter account isn't registered in EZTwitBot.");
          else console.error(err);
        }
      },
    },
    api: {
      grammar: {
        $$botid: {
          async $get(req, res, { botid }) {
            if (botid == null) res.status(400).send("Bot ID Missing");
            else if (!/^[0-9]+$/.test(botid))
              res.status(400).send("Invalid ID");
            try {
              const grammar = await db.getGrammar(botid);
              res.json(
                req.query.pretty
                  ? JSON.stringify(grammar, null, 2)
                  : JSON.stringify(grammar)
              );
            } catch (err) {
              if (err === 404)
                return res
                  .status(404)
                  .send("This twitter account isn't registered in EZTwitBot.");
              console.error(err);
              res.sendStatus(500);
            }
          },
          async $put(req, res, { botid }) {
            const sessId = req.session.botid;
            if (sessId == null) res.status(403).send("Unauthenticated.");
            else if (botid == null) res.status(400).send("Bot ID Missing");
            else if (sessId !== botid)
              res.status(403).send(`You aren't ${botid}.`);
            else if (!/^[0-9]+$/.test(botid))
              res.status(400).send("Invalid ID");
            /** @type {Record<string, string[]>} */
            let body = "";
            for await (const chunk of req) body += chunk;
            try {
              body = JSON.parse(body);
            } catch (e) {
              return res.status(400).send("Invalid JSON");
            }
            if (typeof body !== "object")
              return res.status(400).send("Invalid JSON");

            // Check body validity
            for (const key in body) {
              if (!keyRegex.test(key))
                return res
                  .status(400)
                  .send(
                    `Invalid key ${key}. Allowed characters: a-z, A-Z, 0-9, underscore (_)`
                  );
              if (!Array.isArray(body[key]))
                return res.status(400).send("Invalid Grammar.");
              for (const value of body[key])
                if (typeof value !== "string")
                  return res.status(400).send("Invalid Grammar.");
                else if (value.length > 280)
                  return res
                    .status(400)
                    .send(
                      `Part ${key} too long for Twitter (Keep it below 280).`
                    );
            }
            if (!("main" in body))
              return res.status(400).send("Invalid Grammar, no main.");
            // Ironically using recursion to check for recursion
            function recursionCheck(key = "main", trace = []) {
              if (!(key in body))
                return `Key ${key} doesn't exist (In ${
                  trace[trace.length - 1]
                })`;
              if (trace.includes(key))
                return (
                  `Recursion (self-referencing keys) detected. ` +
                  `(${trace.join(">")}>${key})`
                );
              for (const part of body[key])
                for (const result of part.matchAll(partRegex)) {
                  const checkResult = recursionCheck(
                    result[1],
                    trace.concat(key)
                  );
                  if (checkResult) return checkResult;
                }
              return false;
            }
            const checkResult = recursionCheck();
            if (checkResult) return res.status(400).send(checkResult);
            try {
              await db.updateGrammar(botid, body);
              res.status(200).send("Edited.");
            } catch (err) {
              console.error(err);
              res
                .status(500)
                .type("html")
                .send(`<img src="/databasebroke.jpg" alt="Database broke"/>`);
            }
          },
        },
      },
    },
  },
  {
    xPoweredBy: "a LOT of squirrels in a BIG wheel (coggers+poggies)",
    notFound: (_, res) => res.status(404).render("404"),
  }
);

const port = process.env.PORT ?? 8080;
coggers.listen(port).then(() => console.log(`Listening on port ${port}!`));
