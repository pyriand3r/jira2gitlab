import * as JiraApi from "jira-client";
import * as gitlab from "node-gitlab";
import { Utils } from "@smallstack/common";
import * as _ from "underscore";
import * as request from "request-promise";

export interface IssueMapping {
    jira: string;
    gitlab: string;
}

export interface UserMapping {
    jiraMail: string;
    gitlabUsername: string;
}

export interface SyncOptions {
    simulation: boolean,
    jira: {
        host: string;
        protocol?: string;
        username: string;
        password?: string;
        projectKey: string;
        strictSSL?: boolean;
    };
    gitlab: {
        url: string;
        privateToken?: string;
        namespace: string;
        projectName: string;
    };
    issueMapping: IssueMapping[];
    userMapping: UserMapping[];
}



export class Sync {

    private gitlabProjectMembers: any[];
    private gitlabProject: any;
    private gitlabJiraField: any;
    private jiraClient: any;
    private gitlabClient: any;

    constructor(private options: SyncOptions) { }

    public async doTheDance(): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            const protocol: string = this.options.jira.protocol ? this.options.jira.protocol : "https";
            const strictSSL: boolean = this.options.jira.strictSSL ? this.options.jira.strictSSL : false;
            // const jql: string = encodeURIComponent(`project=${this.options.jira.projectKey}`);

            this.jiraClient = new JiraApi({
                protocol,
                host: this.options.jira.host,
                username: this.options.jira.username,
                password: this.options.jira.password,
                apiVersion: '2',
                strictSSL
            });

            // create jira custom field for syncing already created issues
            const jiraFields = await this.jiraClient.listFields();
            const customJiraFieldName: string = "jira2gitlab";
            this.gitlabJiraField = _.find(jiraFields, (jiraField) => jiraField.name === customJiraFieldName);


            if (this.gitlabJiraField === undefined) {
                console.log("Creating custom jira field : " + customJiraFieldName);
                if (!this.options.simulation) {
                    this.gitlabJiraField = await this.jiraClient.createCustomField({
                        "name": customJiraFieldName,
                        "description": "Custom field for keeping track of already synced issues",
                        "type": "com.atlassian.jira.plugin.system.customfieldtypes:textfield"
                    });
                    await request({
                        url: protocol + "://" + this.options.jira.host + "/rest/api/2/screens/addToDefault/" + this.gitlabJiraField.id,
                        method: "post",
                        auth: {
                            username: this.options.jira.username,
                            password: this.options.jira.password
                        }
                    });
                }
            }

            this.gitlabClient = gitlab.createPromise({
                api: `${this.options.gitlab.url}/api/v3`,
                privateToken: this.options.gitlab.privateToken
            });

            console.log(`Getting gitlab project ${this.options.gitlab.namespace}/${this.options.gitlab.projectName}`);
            const gitlabProjectId: string = this.options.gitlab.namespace + "%2F" + this.options.gitlab.projectName;
            this.gitlabProject = await this.gitlabClient.projects.get({ id: gitlabProjectId });
            if (this.gitlabProject === undefined)
                throw new Error("Could not find gitlab project " + this.options.gitlab.namespace + "/" + this.options.gitlab.projectName);

            console.log(`Getting gitlab project members...`);
            this.gitlabProjectMembers = await this.gitlabClient.projectMembers.list({ id: this.gitlabProject.id });

            console.log(`Getting gitlab namespace members...`);
            try {
                const gitlabGroupMembers = await request.get(this.options.gitlab.url + "/api/v3/groups/" + this.options.gitlab.namespace + "/members", { headers: { "PRIVATE-TOKEN": this.options.gitlab.privateToken }, json: true });
                this.gitlabProjectMembers = this.gitlabProjectMembers.concat(gitlabGroupMembers);
            } catch (e) {
                console.log("Error: " + e.message);
            }

            console.log(`Matching issues...`);

            let startAt: number = 0;
            let maxResults: number = 50;
            let total: number;
            do {
                console.log("Querying Jira, startAt:" + startAt + ", pageSize:" + maxResults);
                const jiraIssues: any = await this.jiraClient.searchJira(`project=${this.options.jira.projectKey}`, { startAt, maxResults });
                if (total === undefined) {
                    total = jiraIssues.total;
                    console.log("  => total size is " + total);
                }
                startAt += maxResults;
                await this.matchIssues(jiraIssues.issues);
            } while ((startAt < total));
        });
    }

    private async matchIssues(jiraIssues: any[]): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            for (const jiraIssue of jiraIssues) {
                const issue: any = Utils.flattenJSON(jiraIssue);
                const gitlabIssueJSON: any = {};
                console.log("Syncing issue: " + issue.key);
                for (const issueMapping of this.options.issueMapping) {
                    if (issue[issueMapping.jira] === undefined) {
                        console.warn("WARNING: skipping field mapping for '" + issueMapping.jira + "' since it doesn't exist on jira issue...");
                        continue;
                    }
                    console.log(`Jira -> ${issueMapping.jira} to Gitlab -> ${issueMapping.gitlab}`);
                    if (issueMapping.gitlab.startsWith("$")) {
                        switch (issueMapping.gitlab) {
                            case "$asLabel":
                                if (gitlabIssueJSON.labels === undefined)
                                    gitlabIssueJSON.labels = issue[issueMapping.jira];
                                else
                                    gitlabIssueJSON.labels += "," + issue[issueMapping.jira];
                                console.log("  => New Label: " + issue[issueMapping.jira]);
                                break;
                            default:
                                throw new Error("Unknown operator: " + issueMapping.gitlab);
                        }
                    }
                    else {
                        console.log("  => Value: " + issue[issueMapping.jira]);
                        gitlabIssueJSON[issueMapping.gitlab] = issue[issueMapping.jira];
                    }
                }

                // assignee
                if (jiraIssue.fields.assignee) {
                    const jiraMail: string = jiraIssue.fields.assignee.emailAddress;
                    console.log("Mapping jira assignee " + jiraMail);
                    const userMapping: UserMapping = _.find(this.options.userMapping, (um) => um.jiraMail === jiraMail);
                    if (!userMapping)
                        console.warn("WARNING: No userMapping found for jira user " + jiraMail);
                    else {
                        const gitlabUser: any = _.find(this.gitlabProjectMembers, (gitlabProjectMember) => gitlabProjectMember.username === userMapping.gitlabUsername);
                        if (gitlabUser) {
                            gitlabIssueJSON.assignee_id = gitlabUser.id;
                            console.log("  => Found assigneeId " + gitlabUser.id);
                        }
                        else
                            console.warn("WARNING: Could not find gitlab user " + userMapping.gitlabUsername + " in gitlab project!!!");
                    }
                }

                gitlabIssueJSON.id = this.gitlabProject.id;
                if (!this.options.simulation) {

                    let gitlabIssue: any;
                    let createNewIssue: boolean = true;

                    if (issue["fields." + this.gitlabJiraField.id] !== null) {
                        console.log("Updating gitlab issue " + issue["fields." + this.gitlabJiraField.id]);
                        gitlabIssueJSON.issue_id = issue["fields." + this.gitlabJiraField.id];
                        try {
                            gitlabIssue = await this.gitlabClient.issues.update(_.clone(gitlabIssueJSON));
                            createNewIssue = false;
                        } catch (e) {
                            console.log("The Gitlab issue, which was referenced on the Jira issue (#" + issue["fields." + this.gitlabJiraField.id] + "), could not be found, creating / linking new one!");
                            gitlabIssueJSON.issue_id = undefined;
                        }

                    }
                    if (createNewIssue) {
                        console.log("Creating new gitlab issue!");
                        gitlabIssue = await this.gitlabClient.issues.create(gitlabIssueJSON);
                        // time spent
                        if (typeof issue["fields.timespent"] === "number" && issue["fields.timespent"] > 0) {
                            try {
                                console.log("adding worklog: " + issue["fields.timespent"]);
                                await this.gitlabClient.issues.addTimeSpent({ id: gitlabIssue.project_id, issue_id: gitlabIssue.id, duration: issue["fields.timespent"] + "s" });
                            } catch (e) {
                                console.error("Adding worklog failed : ", e);
                            }
                        }
                        // updating jira issue with gitlab issueID
                        const jiraUpdate: any = { fields: {} };
                        jiraUpdate.fields[this.gitlabJiraField.id] = "" + gitlabIssue.id;
                        console.log("Updating jira issue with ", jiraUpdate);
                        await this.jiraClient.updateIssue(jiraIssue.id, jiraUpdate);
                    }

                    // resolution available?
                    if (issue["fields.resolution"] !== null) {
                        console.log("setting to closed...");
                        await this.gitlabClient.issues.update({ id: gitlabIssue.project_id, issue_id: gitlabIssue.id, state_event: "close" });
                    }



                }
            }
            resolve();
        });
    }
}