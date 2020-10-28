#!/usr/bin/env node
const chalk = require("chalk");
const yargs = require("yargs");
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const dns = require("dns");
const process = require('child_process');

const Configstore = require('configstore');

const conf = new Configstore('prauxyssl');


const header = chalk.cyan.bold("PrauxySSL")

// TODO: Automate this http://127.0.0.1:9222/json/version
var wsUrl;

console.log(header)

const confirmChromeInstance = async () => {
    return new Promise((resolve, reject) => {
        console.log("before fetch")
        fetch("http://127.0.0.1:9222/json/version").then(res => res.json()).then(body => {
            if(body.webSocketDebuggerUrl == undefined) {
                console.log(chalk.red.bold("Chrome missing debugger; please open port 9222 ws debug"))
                return reject("invalid chrome debug status");
            }
        
            wsUrl = body.webSocketDebuggerUrl;
            resolve()
        }).catch(e => {
            console.log(e);
            reject(e);
        })
    })
}

const verifyTxt = async (domain, supposedToBe, yargs) => {
    return new Promise(resolve => {
        const checkDomain = `_acme-challenge.${domain.slice(2)}`

        dns.resolveTxt(checkDomain, async (err, res) => {
            if(err) {
                await verifyTxt(domain, supposedToBe, yargs);
                resolve(true);
            }
            const txt = res[0][0] || res[0]
            if(txt == supposedToBe) {
                if(yargs.verbose) console.log(chalk.green(`Verified DNS`))
                resolve("COMPLETE");
            } else {
                if(yargs.verbose) console.log(chalk.magenta(`DNS TXT not updated yet, trying again in 5 seconds...`))
                setTimeout(async function() {
                    await verifyTxt(domain, supposedToBe, yargs);
                    resolve(true);
                }, 5000)
            }
        })
    })
}

const setupCommand = {
    command: "$0",
    desc: "Create a new certificate",
    builder: (yargs) => {
        yargs.options("d", { 
            alias: "domain",
            describe: "A domain you want to create an SSL certificate for",
            type: "string",
            demandOption: true
          }).options("v", { 
            alias: "verbose",
            describe: "Log verbose",
            type: "boolean",
          }).options("t", { 
            alias: "testing",
            describe: "Put LetsEncrypt into testing mode",
            type: "boolean",
          })
    },
    handler: newCert
}

const options = yargs.usage("Usage: -d <domain>")
                     .middleware([confirmChromeInstance])
                     .command("renew", "Renew all certificates", (yargs) => {
                        console.log("Hello world")
                     })
                     .command(setupCommand)
                     .argv;

async function requestCertificate(yargs, page) {    
    return new Promise(async (resolve) => {
        const cmd = `certbot certonly${yargs.testing ? " --staging" : ""} --force-interactive --agree-tos -m kvizdos@gmail.com -d ${yargs.domain} --manual --preferred-challenges dns --manual-public-ip-logging-ok`
        const ran = process.exec(cmd);

        let outHistory = [];

        ran.stdout.on('data', async function(output) {            
            const lines = output.split("\n");

            if(lines[3].indexOf("with the following value:") != -1) {
                const acme = lines[5]

                console.log(chalk.green("Found ACME code: " + acme))

                await setGoogleDns(acme, yargs, page);

                ran.stdin.write("\n")
            }
        })

        ran.stdout.on('close', function() {
            return resolve(true)
        })

        ran.stderr.on('data', function(output) {
            if(yargs.verbose) console.log(chalk.white(output))
        })
    })
}

async function setGoogleDns(acme, yargs, page) {
    if(yargs.verbose) console.log(chalk.yellow(`Starting JavaScript evaluation...`))

    await page.evaluate(async () => {
        let customResources = Array.from(document.querySelectorAll("h3")).filter(el => el.innerText == "Custom resource records")[0];
        let acme = Array.from(document.querySelectorAll("#gwt-uid-4 > tbody > tr")).filter(el => el.innerText.split("\n")[0] == "_acme-challenge")

        if(acme[0] != undefined) {
            Array.from(acme[0].querySelectorAll('td')).filter(el => el.innerText == "Delete")[0].children[0].children[0].children[0].click();
            
            const btn = [...document.querySelectorAll("button[type='submit']")].pop()
            btn.click();
        }
    })

    if(yargs.verbose) console.log(chalk.green(`JavaScript evaluation complete.`))
    if(yargs.verbose) console.log(chalk.yellow(`Starting to create custom TXT record...`))

    await page.focus('input[placeholder="@"');
    await page.keyboard.type("_acme-challenge")
    await page.keyboard.press("Tab")
    await page.keyboard.press("Enter")

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');

    await page.keyboard.press("Enter")
    await page.keyboard.press("Tab")

    await page.keyboard.type("1m")

    await page.keyboard.press("Tab")
    
    await page.keyboard.type(acme)

    await page.keyboard.press("Tab")
    await page.keyboard.press("Tab")

    await page.keyboard.press("Enter")

    if(yargs.verbose) console.log(chalk.green(`TXT record created`))
    console.log(chalk.yellow(`Waiting for DNS TXT record to verify...`))
    await verifyTxt(yargs.domain, acme, yargs)
    console.log(chalk.green(`DNS Verified`))

}

async function newCert(yargs) {
    const isWildcard = yargs.domain.indexOf("*.") >= 0;

    if(!isWildcard) {
        console.log(chalk.red(`Provided domain is not a wildcard domain: ${yargs.domain}`))

        return;
    }

    console.log(chalk.yellow(`Obtaining certificate for the domain: ${yargs.domain}`))

    if(yargs.verbose) console.log(chalk.yellow(`Launching Chrome...`))

    const browser = await puppeteer.connect({
        browserWSEndpoint: wsUrl,
        headless: false
    });
    var page = await browser.newPage();
    await page.goto(`https://domains.google.com/registrar/${yargs.domain.slice(2)}/dns`);
    await page.setViewport({height: 1080, width: 1920});
    await page.waitForSelector("tbody")

    if(yargs.verbose) console.log(chalk.yellow(`Requesting certificate from LetsEncrypt...`))

    await requestCertificate(yargs, page);
    
    console.log(chalk.green(`LetsEncrypt certificate obtained.`))
    return -1;
}
                    