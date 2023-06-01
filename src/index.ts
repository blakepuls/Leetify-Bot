import puppeteer, { ElementHandle, Puppeteer } from "puppeteer";
import fs from "fs";
import { load } from "cheerio";
import https from "https";
import { TextChannel, Client, EmbedBuilder } from "discord.js";
import dotenv from "dotenv";
// import fetch from "node-fetch";

dotenv.config();

if (!process.env.DISCORD_TOKEN) throw new Error("No bot token provided");

if (!process.env.LEETIFY_EMAIL) throw new Error("No leetify email provided");

if (!process.env.LEETIFY_PASSWORD)
  throw new Error("No leetify password provided");

if (!process.env.DISCORD_CHANNEL_ID)
  throw new Error("No Discord channel id provided");

if (!process.env.DEMO_HOST) throw new Error("No demo host provided");

const discord = new Client({
  intents: ["GuildMessages", "Guilds"],
});

interface LeetifyResponse {
  id: string;
  createdAt: string;
  updatedAt: string;
  fileName: string;
  checksum: string | null;
  gameId: string;
  game: {
    recalculate: boolean;
    id: string;
    dataSource: string;
    replayUrl: string | null;
    teamScores: number[];
    finishedAt: string;
    status: string;
    retries: number;
    nextRetryAt: string | null;
    errorCode: string | null;
    createdAt: string;
    gameMapId: number;
    gameMap: {
      id: number;
      name: string;
    };
    mapName: string;
    hasBannedPlayer: boolean;
  };
}

interface Demo {
  leetifyId: string;
  fileName: string;
}

async function downloadDemo(url: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(`./demos/${url}`);
    const request = https.get(
      `https://${process.env.DEMO_HOST}/${url}`,
      function (response) {
        response.pipe(file);
        response.on("end", function () {
          file.end();
          console.log("Downloaded");
          resolve(true);
        });
        response.on("error", function (error) {
          console.error(
            `Failed to download file due to error: ${error.message}`
          );
          resolve(false);
        });
      }
    );

    request.on("error", function (e) {
      console.log("Got error: " + e.message);
      resolve(false);
    });
  });
}

async function sendDiscordMessage(demo: LeetifyResponse): Promise<void> {
  // Check if the Discord bot is ready
  if (!discord?.readyAt) {
    await discord.login(process.env.DISCORD_TOKEN as string);
  }

  const channel = (await discord?.channels.fetch(
    process.env.DISCORD_CHANNEL_ID as string
  )) as TextChannel;

  const embed = new EmbedBuilder()
    .setColor("#e40238")
    .setTitle("Watch Uploaded Demo")
    .setURL(
      `
    https://leetify.com/app/games/${demo?.gameId}/overview`
    )
    .addFields([
      {
        name: "Terrorists",
        value: demo?.game.teamScores[1].toString(),
        inline: true,
      },
      {
        name: "Counter-Terrorists",
        value: demo?.game.teamScores[0].toString(),
        inline: true,
      },
      {
        name: `Map`,
        value: demo?.game.mapName,
        inline: true,
      },
    ]);

  channel.send({
    embeds: [embed],
  });
}

async function uploadDemo(file: string): Promise<LeetifyResponse | null> {
  return new Promise(async (resolve, reject) => {
    const browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
    });
    const page = await browser.newPage();
    await page.goto("https://leetify.com/auth/login");

    // Enter email and password
    await page.focus("#email");
    await page.keyboard.type(process.env.LEETIFY_EMAIL as string);

    await page.focus("#password");
    await page.keyboard.type(process.env.LEETIFY_PASSWORD as string);

    const loginButton = await page.$("input[value='Sign in']");
    loginButton?.click();

    console.log("Waiting for page to load");

    await page.waitForNavigation();

    // Add new vod
    await page.goto("https://leetify.com/app/data-sources");
    console.log("Waiting for page to load 2");
    // await page.waitForNavigation({
    //   waitUntil: "load",
    // });

    console.log("Pressing button");

    const res = await page.waitForXPath(
      "//button[contains(., 'Select demo file')]"
    );

    console.log(res);

    // Get element handle from element
    const elementHandle = res as ElementHandle<Element>;
    elementHandle.click();

    const fileChooser = await page.waitForFileChooser();
    await fileChooser.accept([`./demos/${file}`]);

    await page.setRequestInterception(true);

    page.on("request", (request) => {
      request.continue();
    });

    page.on("response", async (response) => {
      if (response.url() === "https://api.leetify.com/api/games/uploaded") {
        const data = await response.json().catch((err) => {});

        if (!data) return;

        for (let item of data) {
          if (item.fileName === file && item.game.status === "ready") {
            browser.close();
            resolve(item);
          }
        }
      }
    });

    setTimeout(() => {
      browser.close();
      resolve(null);
    }, 600000); // Stop checking after 10 minutes
  });
}

async function getLinks(): Promise<string[]> {
  const response = await fetch(`https://${process.env.DEMO_HOST}/CSGO_10Mans/`);
  const body = await response.text();
  const $ = load(body);

  const links: string[] = [];

  // Each link is in a <a> tag
  $("a").each((_, element) => {
    const url = $(element).attr("href");

    if (url && url.startsWith("pug_")) {
      links.push(url);
    }
  });

  return links;
}

// uploadFile("test.dem");
(async () => {
  const links = await getLinks();
  const demos: Demo[] = JSON.parse(fs.readFileSync("./uploaded.json", "utf-8"));

  for (const link of links) {
    if (!demos.find((demo) => demo.fileName === link)) {
      // Download the link
      const downloaded = await downloadDemo(link);

      if (!downloaded) {
        console.log("Failed to download demo");
        continue;
      }

      // Upload the link
      const uploaded = await uploadDemo(link);
      fs.unlinkSync(`./demos/${link}`);

      if (!uploaded) {
        console.log("Failed to upload demo");
        continue;
      }
      // Add link to uploaded.json
      demos.push({
        leetifyId: uploaded.id,
        fileName: link,
      });
      fs.writeFileSync("./uploaded.json", JSON.stringify(demos, null, 2));

      console.log(
        `Demo uploaded: https://leetify.com/app/match-details/${uploaded.gameId}/overview`
      );

      sendDiscordMessage(uploaded);
    }
  }
})();

setInterval(async () => {
  const links = await getLinks();
  const demos: Demo[] = JSON.parse(fs.readFileSync("./uploaded.json", "utf-8"));

  for (const link of links) {
    if (!demos.find((demo) => demo.fileName === link)) {
      // Download the link
      const downloaded = await downloadDemo(link);

      if (!downloaded) {
        console.log("Failed to download demo");
        continue;
      }

      // Upload the link
      const uploaded = await uploadDemo(link);
      fs.unlinkSync(`./demos/${link}`);

      if (!uploaded) {
        console.log("Failed to upload demo");
        continue;
      }
      // Add link to uploaded.json
      demos.push({
        leetifyId: uploaded.id,
        fileName: link,
      });
      fs.writeFileSync("./uploaded.json", JSON.stringify(demos, null, 2));

      console.log(
        `Demo uploaded: https://leetify.com/app/match-details/${uploaded.gameId}/overview`
      );

      sendDiscordMessage(uploaded);
    }
  }
}, 3 * 60 * 1000);
