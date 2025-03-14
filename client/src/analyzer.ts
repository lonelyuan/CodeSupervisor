// 前端使用LLM分析的模块，已弃用

import * as vscode from "vscode";
import { SecurityIssue, AnalysisResult } from "./types";
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: '7373221e-dd8a-44e3-9281-71ec333b2199',//APIKEY
  baseURL: 'https://ark.cn-beijing.volces.com/api/v3',//请求的大模型url
});

export class SecurityAnalyzer {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private defaultModel = "deepseek-v3-241226";//模型类型

  constructor() {
    this.diagnosticCollection =
    vscode.languages.createDiagnosticCollection("codeguardian");
  }

  async analyzeCode(code: string, language: string,filename: string): Promise<AnalysisResult> {
    try {
      const completion = await openai.chat.completions.create({
        messages: [
          { role: 'system', content: `你是一个代码安全漏洞分析领域的专家. 
Format each issue exactly as:
### <漏洞名称>
Type: <类型>
Line: <line number>
Description: <清晰、具体的描述>
Severity: <critical|high|medium|low>` },
          { role: 'user', content: `分析这段 ${language}代码 并将其中的安全漏洞作为结果返回:\n\n${this.addLineNumbers(
              code
            )}` },
        ],
        model: this.defaultModel,
        temperature: 0.3,
      });

      const content = completion.choices[0].message.content;
      const issues = this.parseSecurityIssues(content!,filename);
      return { issues };
    } catch (error) {
      console.error("分析错误:", error);
      throw new Error(
        `无法分析代码: ${
          error instanceof Error ? error.message : "未知错误"
        }`
      );
    }
  }

  private addLineNumbers(code: string): string {
    return code
      .split("\n")
      .map((line, index) => `${index + 1}: ${line}`)
      .join("\n");
  }

  private parseSecurityIssues(llmResponse: string,filename: string): SecurityIssue[] {
    const issues: SecurityIssue[] = [];

    // 按###分割
    const sections = llmResponse.split(/###\s+/);

    for (const section of sections) {
      if (
        !section.trim() ||
        section.toLowerCase().includes("fix recommendations")
      ){continue;}

      try {
        // 按行分隔，获取漏洞名称
        const lines = section.split("\n");
        const vulnerabilityName = lines[0].trim();

        // 正则表达式
        const typeMatch = section.match(/Type:\s*(.*?)(?=\n|$)/);
        const lineMatch = section.match(/Line:\s*(\d+)/);
        const descMatch = section.match(
          /Description:\s*(.*?)(?=\n|Severity:|$)/
        );
        const sevMatch = section.match(/Severity:\s*(.*?)(?=\n|$)/);

        if (typeMatch && lineMatch && descMatch && sevMatch) {
          // 添加修复建议
          const fixRec = llmResponse.includes("Fix Recommendations")
            ? this.findFixRecommendation(llmResponse, typeMatch[1])
            : "";

          const issue: SecurityIssue = {
            message: this.formatMessage(
              vulnerabilityName,
              descMatch[1].trim(),
              fixRec,
            ),
            severity: this.mapSeverity(sevMatch[1].trim()),
            line: parseInt(lineMatch[1], 10),
            column: 1,
            rule: typeMatch[1].trim().toUpperCase().replace(/\s+/g, "_"),
            filename,
          };

          if (issue.line > 0) {
            issues.push(issue);
          }
        }
      } catch (error) {
        console.error("转换时出错:", error, "\n出错位置:", section);
        continue;
      }
    }

    return issues;
  }

  private findFixRecommendation(
    fullResponse: string,
    issueType: string
  ): string {
    try {
      const fixSection = fullResponse.split("### Fix Recommendations")[1];
      if (!fixSection) {return "";}

      const fixes = fixSection.split(/\d+\./);
      for (const fix of fixes) {
        if (fix.toLowerCase().includes(issueType.toLowerCase())) {
          const codeSectionStart = fix.indexOf("```");
          return codeSectionStart !== -1
            ? fix.substring(0, codeSectionStart).trim()
            : fix.trim();
        }
      }
    } catch (error) {
      console.error("修复建议出错:", error);
    }
    return "";
  }

  private formatMessage(
    vulnerability: string,
    description: string,
    fix: string
  ): string {
    let message = `${vulnerability}\n${description}`;
    if (fix) {
      message += `\n\nRecommended Fix: ${fix}`;
    }
    return message;
  }

  private mapSeverity(
    severity: string
  ): "critical" | "high" | "medium" | "low" {
    const sev = severity.toLowerCase().trim();
    if (sev.includes("critical")) {return "critical";}
    if (sev.includes("high")) {return "high";}
    if (sev.includes("medium")) {return "medium";}
    return "low";
  }

  private getDiagnosticSeverity(severity: string): vscode.DiagnosticSeverity {
    switch (severity) {
      case "critical":
        return vscode.DiagnosticSeverity.Error;
      case "high":
        return vscode.DiagnosticSeverity.Error;
      case "medium":
        return vscode.DiagnosticSeverity.Warning;
      case "low":
        return vscode.DiagnosticSeverity.Information;
      default:
        return vscode.DiagnosticSeverity.Hint;
    }
  }

  private getDiagnosticRange(
    document: vscode.TextDocument,
    issue: SecurityIssue
  ): vscode.Range {
    try {
      const lineIndex = Math.max(issue.line - 1, 0);

      // Handle case where line number is beyond document length
      if (lineIndex >= document.lineCount) {
        console.warn(
          `Line number ${issue.line} is beyond document length ${document.lineCount}`
        );
        return new vscode.Range(
          new vscode.Position(document.lineCount - 1, 0),
          new vscode.Position(document.lineCount - 1, 1)
        );
      }

      // Get the line text
      const lineText = document.lineAt(lineIndex).text;

      // If line is empty or only whitespace, try to find nearest non-empty line
      if (!lineText.trim()) {
        return this.findNearestCodeRange(document, lineIndex);
      }

      // Normal case - line has content
      const startChar = lineText.search(/\S/); // Find first non-whitespace character
      const endChar = lineText.length;

      // If no non-whitespace characters found, highlight whole line
      if (startChar === -1) {
        return new vscode.Range(
          new vscode.Position(lineIndex, 0),
          new vscode.Position(lineIndex, endChar)
        );
      }

      return new vscode.Range(
        new vscode.Position(lineIndex, startChar),
        new vscode.Position(lineIndex, endChar)
      );
    } catch (error) {
      console.error("Error creating diagnostic range:", error);
      // Fallback to a safe range
      return new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(0, 1)
      );
    }
  }

  private findNearestCodeRange(
    document: vscode.TextDocument,
    lineIndex: number
  ): vscode.Range {
    const maxLines = document.lineCount;
    let searchRadius = 1;
    const maxSearchRadius = 5; // Maximum lines to search up or down

    while (searchRadius <= maxSearchRadius) {
      // Check lines above
      if (lineIndex - searchRadius >= 0) {
        const upperLine = document.lineAt(lineIndex - searchRadius).text;
        if (upperLine.trim()) {
          return new vscode.Range(
            new vscode.Position(
              lineIndex - searchRadius,
              upperLine.search(/\S/)
            ),
            new vscode.Position(lineIndex - searchRadius, upperLine.length)
          );
        }
      }

      // Check lines below
      if (lineIndex + searchRadius < maxLines) {
        const lowerLine = document.lineAt(lineIndex + searchRadius).text;
        if (lowerLine.trim()) {
          return new vscode.Range(
            new vscode.Position(
              lineIndex + searchRadius,
              lowerLine.search(/\S/)
            ),
            new vscode.Position(lineIndex + searchRadius, lowerLine.length)
          );
        }
      }

      searchRadius++;
    }

    // Fallback to highlighting the empty line itself
    return new vscode.Range(
      new vscode.Position(lineIndex, 0),
      new vscode.Position(lineIndex, 1)
    );
  }

  public updateDiagnostics(
    document: vscode.TextDocument,
    issues: SecurityIssue[]
  ): void {
    const diagnostics: vscode.Diagnostic[] = [];

    for (const issue of issues) {
      try {
        const range = this.getDiagnosticRange(document, issue);
        const diagnostic = new vscode.Diagnostic(
          range,
          issue.message,
          this.getDiagnosticSeverity(issue.severity)
        );

        diagnostic.code = {
          value: issue.rule,
          target: vscode.Uri.parse(`https://owasp.org/www-project-top-ten/`),
        };

        diagnostic.source = "CodeGuardian";
        diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];

        // Add related information with proper line reference
        const lineText = document.lineAt(range.start.line).text;
        diagnostic.relatedInformation = [
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(document.uri, range),
            `Vulnerable code [Line ${issue.line}]: ${
              lineText.trim() || "(empty line)"
            }`
          ),
        ];

        diagnostics.push(diagnostic);
      } catch (error) {
        console.error("创建分析失败:", error, issue);
      }
    }

    this.diagnosticCollection.set(document.uri, diagnostics);

    // Show summary in status bar
    if (diagnostics.length > 0) {
      vscode.window
        .showInformationMessage(
          `CodeGuardian: 发现 ${diagnostics.length} 个漏洞 ${
            diagnostics.length === 1 ? "issue" : "issues"
          }`,
          "展示细节"
        )
        .then((selection) => {
          if (selection === "展示细节") {
            vscode.commands.executeCommand("workbench.action.problems.focus");
          }
        });
    }
  }
}
