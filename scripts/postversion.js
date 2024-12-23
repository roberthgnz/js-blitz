const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const { version, repository } = packageJson;

const readmePath = path.join(process.cwd(), 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');

function updateDownloadLink(content) {
    const repoUrl = typeof repository === 'string' ? repository : repository.url;
    const repoName = repoUrl
        .replace('git+', '')
        .replace('.git', '');

    const downloadUrl = `${repoName}/releases/download/v${version}/JSBlitz-${version}.Setup.exe`;

    const imgRegex = /\[!\[DOWNLOAD\]\([^\)]+\)\]\([^\)]+\)/;
    const newImgMarkdown = `[![DOWNLOAD](https://github.com/user-attachments/assets/0b711e06-b18a-4b41-961f-c9e4c31df8b4)](${downloadUrl})`;

    if (content.match(imgRegex)) {
        return content.replace(imgRegex, newImgMarkdown);
    }

    return `${content}\n\n${newImgMarkdown}`;
}

const updatedReadme = updateDownloadLink(readme);

fs.writeFileSync(readmePath, updatedReadme, 'utf8');

try {
    execSync('git add .');
    execSync(`git commit -m "docs: update download link to version ${version}"`);
} catch (error) {
    console.error(error.message)
    process.exit(1);
}