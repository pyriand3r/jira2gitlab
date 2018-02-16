# Disclaimer

This is a fork of [smallstacks jira2gitlab](https://gitlab.com/smallstack/jira2gitlab). I have fixed a bug and added (tons of) additional features and imports.

---

# Motivation

We recently moved from Jira/Bitbucket to Gitlab and needed our tickets. I found smallstacks neat script but it did too less, so i extended it and made most of the features optional so everyone can decide how and what to import.

## Features

With this tool you can transfer issues from jira to gitlab on a project base. It maps one jira project to a gitlab project.

IMPORTANT: For the user mapping the gitlab users need access to the target gitlab project. 

### Basic

- Syncs issues based on configuration
- Jira (custom-)fields can be mapped to Gitlab fields
- Jira users can be mapped to Gitlab users
- If a jira resolution exists, the issue will be closed on Gitlab
- Map fields with single value, array of values and even array of objects to gitlab labels

### Optional

- Re-Sync works via custom jira field that stores the Gitlab issue ID
- Jira worklogs get added once on gitlab issue creation
- Jira estimated time get added to gitlab issue
- Backlink to original issue as comment
- Add issues as the original author if mapped (defined gitlab user needs to have administration permissions)
- When importing $asLabel you can define filter regexes to clean up the imported labels from the mapping rule.
- When importing $asLabel you can define a prefix that is added to all labels from the mapping rule
- Import attachments
- Import comments (as the original user)
- ignore issues on state (closed) or date (created/updated)

## Things to know

- The CLI creates a new custom field in Jira called 'jira2gitlab' where it stores the gitlab issue ID. This custom field 
is automatically added to the 'default screen' of Jira.
- We imply that, after syncing an issue from Jira to Gitlab, the issue is being processed further on Gitlab only. 
This is currently only relevant for the timespent field (which will not get updated again on a re-sync)
- You need an administrator account on Jira side and a private token that is allowed to modify project issues on gitlab's side.

# Install

```bash
git clone https://github.com/pyriand3r/jira2gitlab.git
cd jira2gitlab
npm install
```

# Quick-start

Create a config.json and add the following content: 

```json
{
    "logger": {
        "level": "info",
        "toFile": true,
        "file": "jira2gitlab.log"
    },
    "jira": {
        "host": "your.jira.com",
        "username": "max",
        "password": "XXX",
        "projectKey": "CUPPY",
        "strictSSL": true,
        "protocol": "http|https"
    },
    "gitlab": {
        "url": "https://gitlab.com",
        "privateToken": "XXX",
        "namespace": "example",
        "projectName": "cuppy"
    },
    "general": {
        "worklog": true,
        "estimatedTime": true,
        "backlink": true,
        "asOriginalAuthor": true,
        "comments": true,
        "attachments": true,
        "syncField": true,
        "ignoreIssues": {
            "closed": false,
            "date": false,
            "dateConfig": {
                "date": "2016-12-31",
                "type": "created|updated"
            }
        }
    },
    "issueMapping": [
        {
            "jira": "fields.issuetype.name",
            "gitlab": "$asLabel"
        },
        {
            "jira": "fields.summary",
            "gitlab": "title"
        },
        {
            "jira": "fields.description",
            "gitlab": "description"
        }
    ],
    "userMapping": [
        {
            "jiraMail": "max@smallstack.io",
            "gitlabUsername": "maxfriedmann"
        },
        {
            "jiraMail": "timo@smallstack.io",
            "gitlabUsername": "timokaiser"
        }
    ]
}
```

Afterwards you can call the CLI in this folder via:

```bash
$ jira2gitlab
```

# Options

## logger

The progress is logged to the console but if you want you can write the log to a file, too.

**level** {string} Defines the log level. default should be `info` but if you want more or less output you can use `debug`, `warning` or `error`, too.

**toFile** {bool} Write the log to a file, too.

**file** {string} The path to the file to write the log to.

## jira

Defines your jira instance aka the source and login information. I think everything is self-explaining.

## gitlab

Defines your gitlab instance aka the target. Again self-explaining I would say.

## general

Here you can activate/deactivate general apply rules

**worklog** {bool} Wether or not the worklog should be applied.

**estimatedTime** {bool} Wether or not the estimated time should be applied.

INFO: worklog and estimated time are added through a new comment.

**backlink** {bool} If true a backlink to the original jira issue will be added as a new comment.

**asOriginalAuthor** {bool} If true the issue and all comments are applied as the original author if a user mapping is found. If false everything is created as the provided gitlab admininstration user.

**comments** {bool} If true the commments will be applied, too.

**attachments** {bool} Wether or not the attachments should be applied. If true all attachments are transfered, a new comment with all attachments is created and the attachments links in the description and the comments are replaced.

**syncField** {bool} By default the script will create a custom field in jira containing the corresponding gitlab issue id. On a second run the gitlab issue gets updated.  

For testing purposes this value should be set to `false` to avoid problems on the real import although a new gitlab issue will be created if the linked issue is not found.

**ingnoreIssues** With this rules you can exclude issues from being imported to gitlab

***closed*** {bool} Wether or not closed issues should be imported

***date*** {bool} Wether or not issues created or updated before the given date in the `dateConfig` should be imported or not.

***dateConfig*** *date* {string} The date string to match. Everything before the date will be ignored.  
***dateConfig*** *type* {string} `created` or `updated` The jira field to test against the defined date.

## issueMapping

Here you can define which jira issue field should be applied to which gitlab issue field. If a defined jira field is not present on an issue the mapping rule will be ignored for that issue.  
There is a special `$asLabel` macro allowing you to import field values as gitlab labels. This works for array fields and even arrays of objects. Beyond that mapping rules using the `$asLabel` macro provide some more configuration options:

**jira** {string} The jira issue field to map.

**gitlab** {string} The gitlab issue field to apply to.

**field** {string} (optional) When using the `$asLabel` macro on an issue field containing an array of objects you can define here the name of the attribute to use as label.

**filter** {string[]} (optional) When using the `§asLabel` macro on a field containing an array you can define here a list of regex patterns. All labels matching one of the pattern will not be applied.

**prefix** {string} (optional) Here you can define a prefix that will be attached to all labels imported through the mapping rule. Neat if you want to import a field containing a value that itself is not very meaningful.

**lowercase** {bool} (optional) When set to true all created labels are lowercased.

## Use a project mapping file

If you want to transfer multiple projects to gitlab, you can specify a project mapping file. It is a json file containing an array of project mappings:

```json
[
    {
        "jiraProject": "CUPPY",
        "gitlabNamespace": "example",
        "gitlabProject": "cuppy"
    },
    {
        "jiraProject": "ANOTHER",
        "gitlabNamespace": "example",
        "gitlabProject": "another"
    },
]
```

You can specify the file with the `--projectMapping` start parameter:

```bash
jira2gitlab --projectMapping=/path/to/mappingFile.json
```

The path is either the full path or relative to the location of the `jira2gitlab` execution file.