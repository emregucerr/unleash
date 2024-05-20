import { render } from 'utils/testRenderer';
import { screen, waitFor } from '@testing-library/react';
import { ImportModal } from './ImportModal';
import { testServerRoute, testServerSetup } from 'utils/testServer';
import userEvent from '@testing-library/user-event';
import { CREATE_FEATURE } from 'component/providers/AccessProvider/permissions';

const server = testServerSetup();

const setupApi = () => {
    testServerRoute(server, '/api/admin/ui-config', {
        versionInfo: {
            current: { enterprise: 'present' },
        },
    });
    testServerRoute(server, '/api/admin/projects/default', {
        environments: [
            { environment: 'development' },
            { environment: 'production' },
        ],
    });
    testServerRoute(
        server,
        '/api/admin/features-batch/validate',
        { errors: [], permissions: [], warnings: [] },
        'post',
    );
    testServerRoute(server, '/api/admin/features-batch/import', {}, 'post');
};

const importFile = async (content: string) => {
    const selectFileInput = screen.getByTestId('import-file');
    const importFile = new File([content], 'import.json', {
        type: 'application/json',
    });
    userEvent.upload(selectFileInput, importFile);
};

test('Import happy path', async () => {
    setupApi();
    let closed = false;
    const setOpen = (open: boolean) => {
        closed = !open;
    };
    let imported = false;
    const onImport = () => {
        imported = true;
    };
    render(
        <ImportModal
            open={true}
            setOpen={setOpen}
            project='default'
            onImport={onImport}
        />,
        {
            permissions: [{ permission: CREATE_FEATURE }],
        },
    );

    // configure stage
    screen.getByText('Import options');
    screen.getByText('Drop your file here');
    const validateButton = screen.getByText('Validate');
    expect(validateButton).toBeDisabled();

    await importFile('{}');
    await waitFor(() => {
        expect(screen.getByText('Validate')).toBeEnabled();
    });

    const codeEditorLabel = screen.getByText('Code editor');
    codeEditorLabel.click();
    const editor = screen.getByLabelText('Exported toggles');
    expect(editor.textContent).toBe('{}');

    screen.getByText('Validate').click();

    // validate stage
    screen.getByText('You are importing this configuration in:');
    screen.getByText('development');
    screen.getByText('default');
    const importButton = screen.getByText('Import configuration');
    expect(importButton).toBeEnabled();
    importButton.click();

    // import stage
    await screen.findByText('Importing...');
    await screen.findByText('Import completed');

    expect(imported).toBe(true);

    expect(closed).toBe(false);
    const closeButton = screen.getByText('Close');
    closeButton.click();
    expect(closed).toBe(true);
});

test('Block when importing non json content', async () => {
    setupApi();
    const setOpen = () => {};
    const onImport = () => {};
    render(
        <ImportModal
            open={true}
            setOpen={setOpen}
            project='default'
            onImport={onImport}
        />,
        {
            permissions: [{ permission: CREATE_FEATURE }],
        },
    );

    const codeEditorLabel = screen.getByText('Code editor');
    codeEditorLabel.click();
    const editor = screen.getByLabelText('Exported toggles');
    userEvent.type(editor, 'invalid non json');

    const validateButton = screen.getByText('Validate');
    expect(validateButton).toBeDisabled();
});

test('Show validation errors', async () => {
    setupApi();
    testServerRoute(
        server,
        '/api/admin/features-batch/validate',
        {
            errors: [
                { message: 'error message', affectedItems: ['itemC', 'itemD'] },
            ],
            permissions: [
                {
                    message: 'permission message',
                    affectedItems: ['itemE', 'itemF'],
                },
            ],
            warnings: [
                {
                    message: 'warning message',
                    affectedItems: ['itemA', 'itemB'],
                },
            ],
        },
        'post',
    );
    const setOpen = () => {};
    const onImport = () => {};
    render(
        <ImportModal
            open={true}
            setOpen={setOpen}
            project='default'
            onImport={onImport}
        />,
        {
            permissions: [{ permission: CREATE_FEATURE }],
        },
    );

    await importFile('{}');
    await waitFor(() => {
        expect(screen.getByText('Validate')).toBeEnabled();
    });

    screen.getByText('Validate').click();

    await screen.findByText('warning message');
    await screen.findByText('itemA');
    await screen.findByText('itemB');

    await screen.findByText('error message');
    await screen.findByText('itemC');
    await screen.findByText('itemD');

    await screen.findByText('permission message');
    await screen.findByText('itemE');
    await screen.findByText('itemF');

    const importButton = screen.getByText('Import configuration');
    expect(importButton).toBeDisabled();
});
