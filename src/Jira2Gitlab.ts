// import { prompt, Answers } from "inquirer";
import { Sync } from "./Sync";
import * as fs from "fs-extra";
import * as _ from "underscore";
// import * as path from "path";

export async function CLI() {

    // parse file
    const configFilePath: string = "config.json";
    if (!fs.existsSync(configFilePath))
        throw new Error("File does not exist: " + configFilePath);
    const configuration: any = fs.readJsonSync(configFilePath);

    // parse arguments
    process.argv.splice(0, 2);
    _.each(process.argv, function (arg) {
        if (arg === "--simulate") {
            configuration.simulation = true;
            console.log("=> Simulating all actions!!!")
        }
    });


    // const answers: Answers = await prompt([
    //     {
    //         type: "password",
    //         name: "gitlabPassword",
    //         message: "Jira Password"
    //     }
    // ]);


    await new Sync(configuration).doTheDance().catch((error: Error) => {
        console.log("Error: " + error);
        console.log(error.stack);
    });
}
