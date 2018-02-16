import {Sync} from "./Sync";
import * as fs from "fs-extra";
import * as _ from "underscore";
import * as winston from "winston";

export async function CLI() {

    // parse file
    const configFilePath: string = "config.json";
    if (!fs.existsSync(configFilePath))
        throw new Error("File does not exist: " + configFilePath);
    const configuration: any = fs.readJsonSync(configFilePath);

    // configure logger
    let transports = [
        new (winston.transports.Console)({level: configuration.logger.level})
    ];

    if (configuration.logger.toFile === true && configuration.logger.file !== undefined) {
        transports.push(new (winston.transports.File)({
            filename: configuration.logger.file,
            level: configuration.logger.level
        }));
    }

    winston.configure({
        transports: transports
    });

    //process program
    let projectMapping = [];

    process.argv.splice(0, 2);
    _.each(process.argv, function (arg) {
        if (arg === "--simulate") {
            configuration.simulation = true;
            winston.info("=> Simulating all actions!!!")
        } else if (arg.includes('--projectmap=')) {
            winston.info("=> Using file for project mappings");
            let path = arg.split('=')[1];
            projectMapping = require(path);
        }
    });

    let run = async function () {
        await new Sync(configuration).doTheDance().catch((error: Error) => {
            winston.error("Error: " + error);
            winston.error(error.stack);
        })
    };

    if (projectMapping.length > 0) {
        for (let i = 0; i < projectMapping.length; i++) {
            configuration.jira.projectKey = projectMapping[i].jiraProject;
            configuration.gitlab.namespace = projectMapping[i].gitlabNamespace;
            configuration.gitlab.projectName = projectMapping[i].gitlabProject;

            run().catch((error: Error) => {
                winston.error("Error: " + error);
                winston.error(error.stack);
            });
        }
    } else {
        run().catch((error: Error) => {
            winston.error("Error: " + error);
            winston.error(error.stack);
        });
    }
}
