using System;
using System.IO;
using System.Management.Automation;
using System.Management.Automation.Runspaces;
using System.Threading;
using System.Windows.Forms;

internal static class AdvisorHost
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        string root = AppDomain.CurrentDomain.BaseDirectory;
        try
        {
            string script = Path.Combine(root, "Advisor.ps1");
            if (!File.Exists(script)) throw new FileNotFoundException("Не найден Advisor.ps1 рядом с приложением.");
            using (Runspace runspace = RunspaceFactory.CreateRunspace())
            {
                runspace.ApartmentState = ApartmentState.STA;
                runspace.ThreadOptions = PSThreadOptions.UseCurrentThread;
                runspace.Open();
                runspace.SessionStateProxy.SetVariable("advisorEntryScript", script);
                using (PowerShell shell = PowerShell.Create())
                {
                    shell.Runspace = runspace;
                    shell.AddScript("Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; & $advisorEntryScript");
                    shell.Invoke();
                    if (shell.HadErrors)
                    {
                        foreach (ErrorRecord error in shell.Streams.Error)
                            MessageBox.Show(error.ToString(), "Ошибка советника", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }
                }
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Не удалось запустить советник", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
