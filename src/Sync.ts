import * as JiraApi from "jira-client";
import * as gitlab from "node-gitlab";
import * as _ from "underscore";
import * as request from "request-promise";

/**
 * @interface IssueMapping
 */
export interface IssueMapping {
    jira: string;
    gitlab: string;
}

/**
 * @interface UserMapping
 */
export interface UserMapping {
    jiraMail: string;
    gitlabUsername: string;
}

/**
 * @interface SyncOptions
 */
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
    general: {
        worklog: boolean;
        estimatedTime: boolean;
        backlink: boolean;
    };
}

/**
 * @class Sync
 */
export class Sync {

    private gitlabProjectMembers: any[];
    private gitlabProject: any;
    private gitlabJiraField: any;
    private jiraClient: any;
    private gitlabClient: any;
    private baseLink: string;

    /**
     * @constructor
     * @param {SyncOptions} options
     */
    constructor(private options: SyncOptions) {
        let proto = this.options.jira.protocol ? this.options.jira.protocol : "https";
        this.baseLink = proto + '://' + options.jira.host;
        if (this.baseLink.endsWith('/')) {
            this.baseLink = this.baseLink.substring(0, this.baseLink.length - 1);
        }
    }

    /**
     * @method doTheDance
     * Perform the complete import
     *
     * @async
     * @returns {Promise<void>}
     */
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
            this.gitlabProject = await this.gitlabClient.projects.get({id: gitlabProjectId});
            if (this.gitlabProject === undefined)
                throw new Error("Could not find gitlab project " + this.options.gitlab.namespace + "/" + this.options.gitlab.projectName);

            console.log(`Getting gitlab project members...`);
            this.gitlabProjectMembers = await this.gitlabClient.projectMembers.list({id: this.gitlabProject.id});

            console.log(`Getting gitlab namespace members...`);
            try {
                const gitlabGroupMembers = await request.get(this.options.gitlab.url + "/api/v3/groups/" + this.options.gitlab.namespace + "/members", {
                    headers: {"PRIVATE-TOKEN": this.options.gitlab.privateToken},
                    json: true
                });
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
                const jiraIssues: any = await this.jiraClient.searchJira(`project=${this.options.jira.projectKey}`, {
                    startAt,
                    maxResults
                });
                if (total === undefined) {
                    total = jiraIssues.total;
                    console.log("  => total size is " + total);
                }
                startAt += maxResults;
                await this.matchIssues(jiraIssues.issues);
            } while ((startAt < total));
        });
    }

    /**
     * @method matchIssues
     *
     * @async
     * @param {any[]} jiraIssues
     * @returns {Promise<void>}
     */
    private async matchIssues(jiraIssues: any[]): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            for (const jiraIssue of jiraIssues) {
                let gitlabIssueJSON: any = {};
                console.log("Syncing issue: " + jiraIssue.key);
                for (const issueMapping of this.options.issueMapping) {
                    if (Sync.resolveAttribute(jiraIssue, issueMapping.jira) === undefined) {
                        console.warn("WARNING: skipping field mapping for '" + issueMapping.jira + "' since it doesn't exist on jira issue...");
                        continue;
                    }
                    console.log(`Jira -> ${issueMapping.jira} to Gitlab -> ${issueMapping.gitlab}`);
                    if (issueMapping.gitlab.startsWith("$")) {
                        gitlabIssueJSON = Sync.resolveMappingMacros(jiraIssue, issueMapping, gitlabIssueJSON)
                    }
                    else {
                        console.log("  => Value: " + Sync.resolveAttribute(jiraIssue, issueMapping.jira));
                        gitlabIssueJSON[issueMapping.gitlab] = Sync.resolveAttribute(jiraIssue, issueMapping.jira);
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

                    let syncField = Sync.resolveAttribute(jiraIssue, "fields." + this.gitlabJiraField.id);
                    if (syncField !== null) {
                        console.log("Updating gitlab issue " + syncField);
                        gitlabIssueJSON.issue_id = syncField;
                        try {
                            gitlabIssue = await this.gitlabClient.issues.update(_.clone(gitlabIssueJSON));
                            createNewIssue = false;
                        } catch (e) {
                            console.log("The Gitlab issue, which was referenced on the Jira issue (#" + syncField + "), could not be found, creating / linking new one!");
                            gitlabIssueJSON.issue_id = undefined;
                        }

                    }
                    if (createNewIssue) {
                        console.log("Creating new gitlab issue!");
                        gitlabIssue = await this.gitlabClient.issues.create(gitlabIssueJSON);
                        // time spent and estimated
                        if (this.options.general.worklog === true
                            || this.options.general.estimatedTime === true) {
                            this.applyTimeLog(jiraIssue, gitlabIssue);
                        }
                        // adding backlink as comment
                        if (this.options.general.backlink === true) {
                            try {
                                await this.gitlabClient.issues.createNote({
                                    id: gitlabIssue.project_id,
                                    issue_id: gitlabIssue.id,
                                    body: 'Imported from jira. Original issue: ' + this.baseLink + '/browse/' + jiraIssue.key
                                });
                            } catch (e) {
                                console.error("Adding of backlink as comment failed: ", e);
                            }
                        }
                        // updating jira issue with gitlab issueID
                        const jiraUpdate: any = {fields: {}};
                        jiraUpdate.fields[this.gitlabJiraField.id] = "" + gitlabIssue.id;
                        console.log("Updating jira issue with ", jiraUpdate);
                        await this.jiraClient.updateIssue(jiraIssue.id, jiraUpdate);
                    }

                    // resolution available?
                    if (jiraIssue.fields.resolution !== null) {
                        console.log("setting to closed...");
                        await this.gitlabClient.issues.update({
                            id: gitlabIssue.project_id,
                            issue_id: gitlabIssue.id,
                            state_event: "close"
                        });
                    }
                }
            }
            resolve();
        });
    }

    /**
     * @method
     * Apply worklog and estimated time
     *
     * @param issue
     * @param gitlabIssue
     * @async
     */
    private async applyTimeLog(issue, gitlabIssue) {
        let note = 'Apply time entries from jira.';
        if (typeof issue.fields.timespent === "number"
            && issue.fields.timespent > 0
            && this.options.general.worklog === true) {
            console.log("adding worklog: " + issue.fields.timespent);
            note += '\n/spend ' + issue.fields.timespent + 's';
        }
        if (typeof issue.fields.timeestimate === 'number'
            && issue.fields.timeestimate > 0
            && this.options.general.estimatedTime === true) {
            console.log('adding estimated time: ' + issue.fields.timeestimate);
            note += '\n/estimate ' + issue.fields.timeestimate + 's';
        }
        try {
            await this.gitlabClient.issues.createNote({
                id: gitlabIssue.project_id,
                issue_id: gitlabIssue.id,
                body: note
            });
        } catch (e) {
            console.error("Adding worklog and/or estimated time failed : ", e);
        }
    }

    /**
     * @method resolveMappingMacros
     *
     * Resolve the mapping macro defined in mapping rule
     *
     * @param issue
     * @param issueMapping
     * @param gitlabIssueJSON
     * @returns {any}
     */
    static resolveMappingMacros(issue, issueMapping, gitlabIssueJSON) {
        switch (issueMapping.gitlab) {
            case "$asLabel":
                gitlabIssueJSON.labels = Sync.resolveLabels(gitlabIssueJSON.labels, issue, issueMapping);
                break;
            default:
                throw new Error("Unknown operator: " + issueMapping.gitlab);
        }
        return gitlabIssueJSON;
    }

    /**
     * @method resolveLabels
     *
     * Resolve labels from the defined jira field
     *
     * @param labels
     * @param issue
     * @param issueMapping
     * @returns {any}
     */
    static resolveLabels(labels, issue, issueMapping) {
        let newLabels = '';
        let attribute = Sync.resolveAttribute(issue, issueMapping.jira);

        if (Array.isArray(attribute)) {
            if (typeof attribute[0] === 'object') {
                newLabels = Sync.resolveObjectLabels(attribute, issueMapping);

            } else {
                newLabels = attribute.join(',');
            }
        } else {
            newLabels += attribute;
        }
        if (labels === undefined)
            labels = newLabels;
        else
            labels += "," + newLabels;
        console.log("  => New Label(s): " + newLabels);
        return labels;
    }

    /**
     * @method resolveAttribute
     *
     * return the value of a defined jira mapping
     *
     * @param issue
     * @param attribute
     * @returns {any}
     */
    static resolveAttribute(issue, attribute) {
        let fieldArray = attribute.split('.');
        let object = issue;
        for (let i = 0; i < fieldArray.length; i++) {
            if (object[fieldArray[i]] !== 'undefined') {
                object = object[fieldArray[i]];
            } else {
                console.log("WARNING: skipping field mapping for '" + attribute + "' since it doesn't exist on jira issue...")
            }
        }
        return object;
    }

    /**
     * @method resolveObjectLabels
     *
     * Resolve labels from array of objects
     *
     * @param attribute
     * @param issueMapping
     * @returns {string}
     */
    static resolveObjectLabels(attribute, issueMapping) {
        let labels = '';

        if (issueMapping.field === undefined) {
            console.error('WARNING: skipping field mapping for ' + issueMapping.jira + ' since "field" isn\'t defined.');
            return labels;
        }
        if (attribute[0][issueMapping.field] === undefined) {
            console.error('WARNING: skipping field mapping for ' + issueMapping.jira + ' since field ' + issueMapping.field + 'isn\'t defined in objects.');
            return labels;
        }

        for (let i = 0; i < attribute.length; i++) {
            labels += attribute[i][issueMapping.field] + ',';
        }
        return labels.substr(0, labels.length - 1);
    }
}